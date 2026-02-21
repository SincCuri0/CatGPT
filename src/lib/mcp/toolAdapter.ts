import path from "path";
import type { Tool, ToolExecutionContext, ToolResult } from "@/lib/core/types";
import type { McpServiceConfig, McpToolDescriptor } from "./types";
import { mcpServiceManager } from "./manager";

function buildMcpToolDescription(tool: McpToolDescriptor): string {
    const tags: string[] = [];
    if (tool.readOnlyHint) tags.push("read-only");
    if (tool.destructiveHint) tags.push("destructive");
    if (tool.privileged) tags.push("privileged");

    const tagSuffix = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
    return `${tool.description} (MCP service: ${tool.serviceName})${tagSuffix}`;
}

function buildErrorResult(error: string): ToolResult {
    return {
        ok: false,
        error,
        output: error,
        artifacts: [],
        checks: [{ id: "mcp_call_failed", ok: false, description: error }],
    };
}

const PATH_ARG_KEYS = [
    "path",
    "filePath",
    "targetPath",
    "source",
    "destination",
    "from",
    "to",
    "oldPath",
    "newPath",
    "dir",
    "directory",
    "uri",
];

function toPosixPath(value: string): string {
    return value.replace(/\\/g, "/");
}

function isFilesystemDescriptor(descriptor: McpToolDescriptor): boolean {
    const serviceText = `${descriptor.serviceId} ${descriptor.serviceName}`.toLowerCase();
    if (/filesystem|file_system|server-filesystem|file-io/.test(serviceText)) {
        return true;
    }
    const toolText = descriptor.toolName.toLowerCase();
    return /read_file|write_file|list_dir|list_directory|search_files|get_file_info|move_file|create_directory/.test(toolText);
}

function toRuntimeToolName(raw: string): string {
    const sanitized = raw
        .replace(/[^a-zA-Z0-9_]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
    const withFallback = sanitized || "tool";
    return /^[a-zA-Z_]/.test(withFallback)
        ? withFallback
        : `tool_${withFallback}`;
}

function resolveWorkspaceScopedPath(rawPath: string, workspaceRoot: string): string | null {
    const normalized = rawPath.trim();
    if (!normalized) return normalized;

    const candidate = normalized.replace(/^file:\/\//i, "");
    const resolved = path.isAbsolute(candidate)
        ? path.resolve(candidate)
        : path.resolve(workspaceRoot, candidate);
    const resolvedRoot = path.resolve(workspaceRoot);
    const relativeToRoot = path.relative(resolvedRoot, resolved);
    const escapesRoot = relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot);
    if (escapesRoot) {
        return null;
    }

    const relativeToCwd = path.relative(process.cwd(), resolved);
    return toPosixPath(relativeToCwd || ".");
}

function scopeFilesystemArgsToAgentWorkspace(
    descriptor: McpToolDescriptor,
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
    if (!isFilesystemDescriptor(descriptor)) {
        return { ok: true, args };
    }

    const workspaceRoot = typeof context?.agentWorkspaceRoot === "string" ? context.agentWorkspaceRoot.trim() : "";
    if (!workspaceRoot) {
        return { ok: true, args };
    }

    const scopedArgs: Record<string, unknown> = { ...args };
    for (const key of PATH_ARG_KEYS) {
        const value = scopedArgs[key];
        if (typeof value !== "string") continue;
        const scoped = resolveWorkspaceScopedPath(value, workspaceRoot);
        if (scoped === null) {
            return {
                ok: false,
                error: `Path '${value}' escapes the agent workspace root '${context?.agentWorkspaceRootRelative || workspaceRoot}'.`,
            };
        }
        scopedArgs[key] = scoped;
    }

    return { ok: true, args: scopedArgs };
}

type McpArtifactShape = {
    kind: "file" | "shell" | "web" | "other";
    operation: string;
    path?: string;
};

function firstStringField(
    value: Record<string, unknown>,
    keys: string[],
): string | undefined {
    for (const key of keys) {
        const candidate = value[key];
        if (typeof candidate === "string" && candidate.trim().length > 0) {
            return candidate.trim();
        }
    }
    return undefined;
}

function inferMcpArtifact(
    descriptor: McpToolDescriptor,
    args: Record<string, unknown>,
): McpArtifactShape {
    const serviceText = `${descriptor.serviceId} ${descriptor.serviceName}`.toLowerCase();
    const toolText = `${descriptor.toolName} ${descriptor.displayName} ${descriptor.description}`.toLowerCase();
    const combined = `${serviceText} ${toolText}`;
    const candidatePath = firstStringField(args, [
        "path",
        "filePath",
        "targetPath",
        "uri",
        "source",
        "destination",
        "from",
        "to",
    ]);

    const looksLikeFilesystem = /filesystem|file_system|file-io|directory|folder|path|read_file|write_file|list_dir/.test(combined);
    if (looksLikeFilesystem) {
        if (/\bappend\b/.test(combined)) {
            return { kind: "file", operation: "append", path: candidatePath };
        }
        if (/\b(delete|remove|unlink)\b/.test(combined)) {
            return { kind: "file", operation: "delete", path: candidatePath };
        }
        if (/\b(create|mkdir|touch|new)\b/.test(combined)) {
            return { kind: "file", operation: "create", path: candidatePath };
        }
        if (/\b(write|edit|update|modify|replace|patch|move|rename|copy)\b/.test(combined)) {
            return { kind: "file", operation: "update", path: candidatePath };
        }
        if (/\b(list|ls|glob|find)\b/.test(combined)) {
            return { kind: "file", operation: "list", path: candidatePath };
        }
        return { kind: "file", operation: "read", path: candidatePath };
    }

    const looksLikeShell = /shell|terminal|command/.test(serviceText)
        || /\b(run|exec|execute|command|spawn)\b/.test(toolText);
    if (looksLikeShell) {
        return { kind: "shell", operation: "execute" };
    }

    const looksLikeWeb = /web|search|browser|fetch|internet|http|url|serp|source/.test(combined);
    if (looksLikeWeb) {
        return { kind: "web", operation: "search" };
    }

    return { kind: "other", operation: "execute" };
}

function mcpToolToRuntimeTool(
    descriptor: McpToolDescriptor,
    services: McpServiceConfig[],
): Tool {
    return {
        id: descriptor.id,
        name: toRuntimeToolName(`mcp_${descriptor.serviceId}_${descriptor.toolName}`),
        description: buildMcpToolDescription(descriptor),
        inputSchema: {
            type: "object",
            properties: descriptor.inputSchema.properties,
            required: descriptor.inputSchema.required,
            additionalProperties: descriptor.inputSchema.additionalProperties,
        },
        privileged: descriptor.privileged,
        execute: async (args: unknown, context?: ToolExecutionContext): Promise<ToolResult> => {
            if (!args || typeof args !== "object" || Array.isArray(args)) {
                return buildErrorResult(`MCP tool '${descriptor.displayName}' requires JSON object arguments.`);
            }
            const callArgs = args as Record<string, unknown>;
            const scopedArgsResult = scopeFilesystemArgsToAgentWorkspace(descriptor, callArgs, context);
            if (!scopedArgsResult.ok) {
                return buildErrorResult(scopedArgsResult.error);
            }
            const scopedArgs = scopedArgsResult.args;

            const response = await mcpServiceManager.callTool(
                services,
                descriptor.serviceId,
                descriptor.toolName,
                scopedArgs,
            );
            const output = response.text || response.error || "MCP tool call completed.";
            const artifact = inferMcpArtifact(descriptor, scopedArgs);

            return {
                ok: response.ok,
                output,
                error: response.ok ? undefined : (response.error || output),
                artifacts: [{
                    kind: artifact.kind,
                    label: "mcp-tool-call",
                    operation: artifact.operation,
                    path: artifact.path,
                    metadata: {
                        serviceId: descriptor.serviceId,
                        serviceName: descriptor.serviceName,
                        toolName: descriptor.toolName,
                        privileged: descriptor.privileged,
                        workspaceRoot: context?.agentWorkspaceRootRelative,
                    },
                }],
                checks: [{
                    id: "mcp_call_ok",
                    ok: response.ok,
                    description: response.ok
                        ? `MCP tool '${descriptor.displayName}' executed successfully.`
                        : `MCP tool '${descriptor.displayName}' failed.`,
                    details: response.error,
                }],
            };
        },
    };
}

export async function getMcpTools(
    services: McpServiceConfig[],
): Promise<Tool[]> {
    const descriptors = await mcpServiceManager.listTools(services);
    const includeReasoningMcp = process.env.MCP_INCLUDE_REASONING_TOOLS === "1";
    const filteredDescriptors = includeReasoningMcp
        ? descriptors
        : descriptors.filter((descriptor) => !/sequential-thinking/i.test(descriptor.serviceId));
    return filteredDescriptors.map((descriptor) => mcpToolToRuntimeTool(descriptor, services));
}
