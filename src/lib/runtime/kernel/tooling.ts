import { toolRegistry } from "@/lib/core/ToolRegistry";
import { debugRouteError } from "@/lib/debug/server";
import { ShellExecuteTool } from "@/lib/tools/computer/shell";
import { WebSearchTool } from "@/lib/tools/web/search";
import { SubAgentsTool } from "@/lib/tools/agent/sessions";
import { getErrorMessage } from "@/lib/runtime/kernel/validation";
import { mcpRuntimeService, type McpCapabilitySummary } from "@/lib/runtime/services/mcpRuntimeService";

let runtimeToolsRegistered = false;

export function ensureRuntimeToolsRegistered(): void {
    if (runtimeToolsRegistered) return;
    toolRegistry.register(ShellExecuteTool);
    toolRegistry.register(WebSearchTool);
    toolRegistry.register(SubAgentsTool);
    runtimeToolsRegistered = true;
}

export interface RuntimeToolLoadResult {
    tools: ReturnType<typeof toolRegistry.getAll>;
    mcpTools: ReturnType<typeof toolRegistry.getAll>;
    mcpLoadError: string | null;
    mcpCapabilities: McpCapabilitySummary;
}

export async function loadRuntimeTools(debugEnabled: boolean, routeName: string): Promise<RuntimeToolLoadResult> {
    ensureRuntimeToolsRegistered();
    const baseTools = toolRegistry.getAll();
    let mcpTools = [] as typeof baseTools;
    let mcpLoadError: string | null = null;
    let mcpCapabilities: McpCapabilitySummary = {
        filesystem: false,
        shell: false,
        web: false,
        reasoning: false,
    };
    try {
        const bundle = await mcpRuntimeService.loadToolBundle();
        mcpTools = bundle.tools;
        mcpCapabilities = bundle.capabilities;
    } catch (error: unknown) {
        mcpLoadError = getErrorMessage(error);
        debugRouteError(debugEnabled, routeName, "Failed to load MCP tools.", error);
    }

    return {
        tools: [...baseTools, ...mcpTools],
        mcpTools,
        mcpLoadError,
        mcpCapabilities,
    };
}
