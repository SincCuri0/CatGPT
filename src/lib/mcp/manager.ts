import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServiceConfig, McpServiceStatus, McpToolDescriptor } from "./types";
import type { ToolInputSchema, ToolSchemaProperty } from "@/lib/core/types";

interface RuntimeToolShape {
    name: string;
    title?: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    annotations?: {
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
    };
}

interface McpServiceRuntime {
    config: McpServiceConfig;
    status: "disabled" | "idle" | "connecting" | "ready" | "error";
    error?: string;
    client: Client | null;
    transport: StdioClientTransport | null;
    connectPromise: Promise<void> | null;
    tools: McpToolDescriptor[];
    toolsRefreshedAt: number;
}

const TOOL_REFRESH_INTERVAL_MS = 30_000;
const MCP_TOOL_ID_PREFIX = "mcp:";
const DEFAULT_OPERATION_TIMEOUT_MS = 12_000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
    });

    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function normalizeServiceId(value: string): string {
    return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

function sanitizeToolNamePart(value: string): string {
    const safe = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
    return safe || "tool";
}

function inferPrivilegedTool(
    toolName: string,
    description: string,
    annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean },
): boolean {
    if (annotations?.destructiveHint === true) return true;
    if (annotations?.readOnlyHint === true) return false;
    const text = `${toolName} ${description}`.toLowerCase();
    return /(write|delete|remove|create|update|patch|exec|command|shell|run|spawn|install)/.test(text);
}

function toObjectSchema(input: unknown): ToolInputSchema {
    if (input && typeof input === "object" && !Array.isArray(input)) {
        const source = input as Record<string, unknown>;
        const properties = source.properties && typeof source.properties === "object" && source.properties !== null
            ? source.properties as Record<string, ToolSchemaProperty>
            : {};
        const required = Array.isArray(source.required)
            ? source.required.filter((entry): entry is string => typeof entry === "string")
            : [];
        return {
            type: "object",
            properties,
            required,
            additionalProperties: typeof source.additionalProperties === "boolean"
                ? source.additionalProperties
                : true,
        };
    }

    return {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: true,
    };
}

function serializeMcpContent(content: unknown): string {
    if (!Array.isArray(content)) {
        if (content === undefined || content === null) return "";
        return typeof content === "string" ? content : JSON.stringify(content, null, 2);
    }

    const chunks: string[] = [];
    for (const item of content) {
        if (!item || typeof item !== "object") {
            chunks.push(String(item));
            continue;
        }

        const entry = item as Record<string, unknown>;
        const type = typeof entry.type === "string" ? entry.type : "";
        if (type === "text" && typeof entry.text === "string") {
            chunks.push(entry.text);
            continue;
        }

        if (type === "resource" && entry.resource && typeof entry.resource === "object") {
            const resource = entry.resource as Record<string, unknown>;
            if (typeof resource.text === "string") {
                chunks.push(resource.text);
                continue;
            }
            chunks.push(JSON.stringify(resource, null, 2));
            continue;
        }

        if (type === "image") {
            chunks.push("[MCP image result]");
            continue;
        }
        if (type === "audio") {
            chunks.push("[MCP audio result]");
            continue;
        }
        if (type === "resource_link") {
            const name = typeof entry.name === "string" ? entry.name : "resource";
            const uri = typeof entry.uri === "string" ? entry.uri : "";
            chunks.push(`${name}${uri ? `: ${uri}` : ""}`);
            continue;
        }

        chunks.push(JSON.stringify(entry, null, 2));
    }

    return chunks.join("\n").trim();
}

function toToolDescriptor(service: McpServiceConfig, tool: RuntimeToolShape): McpToolDescriptor {
    const serviceId = normalizeServiceId(service.id);
    const toolName = tool.name.trim();
    const displayName = tool.title?.trim() || toolName;
    const description = tool.description?.trim() || `${displayName} from ${service.name}`;
    const privileged = inferPrivilegedTool(toolName, description, tool.annotations);
    const safeToolIdPart = sanitizeToolNamePart(toolName);

    return {
        id: `${MCP_TOOL_ID_PREFIX}${serviceId}:${safeToolIdPart}`,
        serviceId,
        serviceName: service.name,
        toolName,
        displayName,
        description,
        inputSchema: toObjectSchema(tool.inputSchema),
        privileged,
        readOnlyHint: tool.annotations?.readOnlyHint,
        destructiveHint: tool.annotations?.destructiveHint,
    };
}

function cloneConfig(config: McpServiceConfig): McpServiceConfig {
    return {
        ...config,
        args: [...config.args],
        env: config.env ? { ...config.env } : undefined,
    };
}

function cloneStatus(runtime: McpServiceRuntime): McpServiceStatus {
    return {
        id: runtime.config.id,
        name: runtime.config.name,
        description: runtime.config.description,
        enabled: runtime.config.enabled,
        command: runtime.config.command,
        args: [...runtime.config.args],
        status: runtime.status,
        error: runtime.error,
        toolCount: runtime.tools.length,
        tools: runtime.tools.map((tool) => ({
            id: tool.id,
            toolName: tool.toolName,
            displayName: tool.displayName,
            privileged: tool.privileged,
        })),
    };
}

export class McpServiceManager {
    private runtimes = new Map<string, McpServiceRuntime>();

    private async closeRuntime(runtime: McpServiceRuntime): Promise<void> {
        runtime.connectPromise = null;
        runtime.tools = [];
        runtime.toolsRefreshedAt = 0;
        const client = runtime.client;
        const transport = runtime.transport;
        runtime.client = null;
        runtime.transport = null;

        try {
            await client?.close();
        } catch {
            // Ignore close failures during refresh/shutdown.
        }
        try {
            await transport?.close();
        } catch {
            // Ignore transport close failures during refresh/shutdown.
        }
    }

    private normalizeConfigs(configs: McpServiceConfig[]): McpServiceConfig[] {
        const output: McpServiceConfig[] = [];
        const seen = new Set<string>();
        for (const raw of configs) {
            const normalizedId = normalizeServiceId(raw.id);
            if (!normalizedId || seen.has(normalizedId)) continue;
            seen.add(normalizedId);
            output.push({
                ...raw,
                id: normalizedId,
                name: raw.name?.trim() || normalizedId,
                command: raw.command?.trim(),
                args: Array.isArray(raw.args) ? raw.args : [],
                transport: "stdio",
            });
        }
        return output;
    }

    public async syncServices(configs: McpServiceConfig[]): Promise<void> {
        const normalized = this.normalizeConfigs(configs);
        const incomingIds = new Set(normalized.map((config) => config.id));

        for (const [serviceId, runtime] of this.runtimes.entries()) {
            if (!incomingIds.has(serviceId)) {
                await this.closeRuntime(runtime);
                this.runtimes.delete(serviceId);
            }
        }

        for (const config of normalized) {
            const existing = this.runtimes.get(config.id);
            if (!existing) {
                this.runtimes.set(config.id, {
                    config: cloneConfig(config),
                    status: config.enabled ? "idle" : "disabled",
                    client: null,
                    transport: null,
                    connectPromise: null,
                    tools: [],
                    toolsRefreshedAt: 0,
                });
                continue;
            }

            const changed = JSON.stringify(existing.config) !== JSON.stringify(config);
            existing.config = cloneConfig(config);
            if (!config.enabled) {
                await this.closeRuntime(existing);
                existing.status = "disabled";
                existing.error = undefined;
                continue;
            }

            if (existing.status === "disabled") {
                existing.status = "idle";
            }

            if (changed) {
                await this.closeRuntime(existing);
                existing.status = "idle";
                existing.error = undefined;
            }
        }
    }

    private async connectRuntime(runtime: McpServiceRuntime): Promise<void> {
        if (!runtime.config.enabled) {
            runtime.status = "disabled";
            return;
        }
        if (runtime.client && runtime.transport && runtime.status === "ready") return;
        if (runtime.connectPromise) {
            await runtime.connectPromise;
            return;
        }

        runtime.status = "connecting";
        runtime.error = undefined;
        runtime.connectPromise = (async () => {
            const transport = new StdioClientTransport({
                command: runtime.config.command,
                args: runtime.config.args,
                cwd: runtime.config.cwd,
                env: runtime.config.env,
                stderr: "pipe",
            });
            const client = new Client(
                { name: "catgpt-mcp-client", version: "0.1.0" },
                { capabilities: {} },
            );

            const timeoutMs = runtime.config.timeoutMs || DEFAULT_OPERATION_TIMEOUT_MS;
            await withTimeout(client.connect(transport), timeoutMs, `Connecting to MCP service '${runtime.config.name}'`);
            runtime.transport = transport;
            runtime.client = client;
            runtime.status = "ready";
            runtime.error = undefined;
        })();

        try {
            await runtime.connectPromise;
        } catch (error: unknown) {
            runtime.status = "error";
            runtime.error = error instanceof Error ? error.message : String(error);
            await this.closeRuntime(runtime);
            throw error;
        } finally {
            runtime.connectPromise = null;
        }
    }

    private async refreshTools(runtime: McpServiceRuntime, force = false): Promise<void> {
        if (!runtime.config.enabled) {
            runtime.tools = [];
            runtime.toolsRefreshedAt = 0;
            return;
        }

        const now = Date.now();
        if (!force && runtime.toolsRefreshedAt > 0 && (now - runtime.toolsRefreshedAt) < TOOL_REFRESH_INTERVAL_MS) {
            return;
        }

        try {
            await this.connectRuntime(runtime);
        } catch (error: unknown) {
            runtime.status = "error";
            runtime.error = error instanceof Error ? error.message : String(error);
            runtime.tools = [];
            runtime.toolsRefreshedAt = 0;
            return;
        }

        if (!runtime.client) {
            runtime.status = "error";
            runtime.error = "MCP client is unavailable after connection.";
            return;
        }

        try {
            const timeoutMs = runtime.config.timeoutMs || DEFAULT_OPERATION_TIMEOUT_MS;
            const list = await withTimeout(
                runtime.client.listTools(),
                timeoutMs,
                `Listing tools for MCP service '${runtime.config.name}'`,
            );
            const tools = Array.isArray(list.tools) ? list.tools : [];
            runtime.tools = tools
                .map((tool) => toToolDescriptor(runtime.config, tool as RuntimeToolShape))
                .filter((tool) => tool.toolName.length > 0);
            runtime.toolsRefreshedAt = now;
            runtime.status = "ready";
            runtime.error = undefined;
        } catch (error: unknown) {
            runtime.status = "error";
            runtime.error = error instanceof Error ? error.message : String(error);
            runtime.tools = [];
            runtime.toolsRefreshedAt = 0;
        }
    }

    public async getServiceStatuses(configs: McpServiceConfig[]): Promise<McpServiceStatus[]> {
        await this.syncServices(configs);
        const statuses: McpServiceStatus[] = [];
        for (const runtime of this.runtimes.values()) {
            if (runtime.config.enabled) {
                try {
                    await this.refreshTools(runtime);
                } catch (error: unknown) {
                    runtime.status = "error";
                    runtime.error = error instanceof Error ? error.message : String(error);
                    runtime.tools = [];
                    runtime.toolsRefreshedAt = 0;
                }
            }
            statuses.push(cloneStatus(runtime));
        }
        statuses.sort((a, b) => a.name.localeCompare(b.name));
        return statuses;
    }

    public async listTools(configs: McpServiceConfig[]): Promise<McpToolDescriptor[]> {
        await this.syncServices(configs);
        const tools: McpToolDescriptor[] = [];
        for (const runtime of this.runtimes.values()) {
            if (!runtime.config.enabled) continue;
            try {
                await this.refreshTools(runtime);
            } catch (error: unknown) {
                runtime.status = "error";
                runtime.error = error instanceof Error ? error.message : String(error);
                runtime.tools = [];
                runtime.toolsRefreshedAt = 0;
            }
            if (runtime.status !== "ready") continue;
            tools.push(...runtime.tools);
        }
        return tools;
    }

    public async callTool(
        configs: McpServiceConfig[],
        serviceId: string,
        toolName: string,
        args: Record<string, unknown>,
    ): Promise<{
        ok: boolean;
        text: string;
        error?: string;
        structuredContent?: Record<string, unknown>;
    }> {
        await this.syncServices(configs);
        const normalizedServiceId = normalizeServiceId(serviceId);
        const runtime = this.runtimes.get(normalizedServiceId);
        if (!runtime || !runtime.config.enabled) {
            return {
                ok: false,
                text: "",
                error: `MCP service '${serviceId}' is not enabled.`,
            };
        }

        try {
            await this.connectRuntime(runtime);
            if (!runtime.client) {
                return {
                    ok: false,
                    text: "",
                    error: `MCP service '${runtime.config.name}' is unavailable.`,
                };
            }

            const timeoutMs = runtime.config.timeoutMs || DEFAULT_OPERATION_TIMEOUT_MS;
            const result = await withTimeout(
                runtime.client.callTool({
                    name: toolName,
                    arguments: args,
                }),
                timeoutMs,
                `Calling MCP tool '${toolName}' on '${runtime.config.name}'`,
            );
            const text = "toolResult" in result
                ? JSON.stringify(result.toolResult, null, 2)
                : serializeMcpContent(result.content);
            const structuredContent = "structuredContent" in result
                && result.structuredContent
                && typeof result.structuredContent === "object"
                && !Array.isArray(result.structuredContent)
                ? result.structuredContent as Record<string, unknown>
                : undefined;

            if ("isError" in result && result.isError) {
                return {
                    ok: false,
                    text,
                    error: text || `MCP tool '${toolName}' returned an error.`,
                    structuredContent,
                };
            }

            return {
                ok: true,
                text,
                structuredContent,
            };
        } catch (error: unknown) {
            runtime.status = "error";
            runtime.error = error instanceof Error ? error.message : String(error);
            return {
                ok: false,
                text: "",
                error: runtime.error,
            };
        }
    }
}

const globalForMcp = globalThis as unknown as {
    __catGptMcpServiceManager?: McpServiceManager;
};

export const mcpServiceManager = globalForMcp.__catGptMcpServiceManager
    || new McpServiceManager();

if (!globalForMcp.__catGptMcpServiceManager) {
    globalForMcp.__catGptMcpServiceManager = mcpServiceManager;
}
