import type { Tool, ToolResult } from "@/lib/core/types";
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

function mcpToolToRuntimeTool(
    descriptor: McpToolDescriptor,
    services: McpServiceConfig[],
): Tool {
    return {
        id: descriptor.id,
        name: `mcp_${descriptor.serviceId}_${descriptor.toolName}`.replace(/[^a-zA-Z0-9_-]+/g, "_"),
        description: buildMcpToolDescription(descriptor),
        inputSchema: {
            type: "object",
            properties: descriptor.inputSchema.properties,
            required: descriptor.inputSchema.required,
            additionalProperties: descriptor.inputSchema.additionalProperties,
        },
        privileged: descriptor.privileged,
        execute: async (args: unknown): Promise<ToolResult> => {
            if (!args || typeof args !== "object" || Array.isArray(args)) {
                return buildErrorResult(`MCP tool '${descriptor.displayName}' requires JSON object arguments.`);
            }

            const response = await mcpServiceManager.callTool(
                services,
                descriptor.serviceId,
                descriptor.toolName,
                args as Record<string, unknown>,
            );
            const output = response.text || response.error || "MCP tool call completed.";

            return {
                ok: response.ok,
                output,
                error: response.ok ? undefined : (response.error || output),
                artifacts: [{
                    kind: "other",
                    label: "mcp-tool-call",
                    operation: "execute",
                    metadata: {
                        serviceId: descriptor.serviceId,
                        serviceName: descriptor.serviceName,
                        toolName: descriptor.toolName,
                        privileged: descriptor.privileged,
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
    return descriptors.map((descriptor) => mcpToolToRuntimeTool(descriptor, services));
}

