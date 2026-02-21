import { getMcpTools } from "@/lib/mcp/toolAdapter";
import { mcpServiceManager } from "@/lib/mcp/manager";
import { readUserSettings } from "@/lib/settings/store";
import type { Tool } from "@/lib/core/types";

export interface McpCapabilitySummary {
    filesystem: boolean;
    shell: boolean;
    web: boolean;
    reasoning: boolean;
}

export interface McpToolBundle {
    tools: Tool[];
    capabilities: McpCapabilitySummary;
}

function emptyCapabilitySummary(): McpCapabilitySummary {
    return {
        filesystem: false,
        shell: false,
        web: false,
        reasoning: false,
    };
}

function classifyCapabilities(tools: Tool[]): McpCapabilitySummary {
    const summary = emptyCapabilitySummary();
    for (const tool of tools) {
        const text = `${tool.id} ${tool.name} ${tool.description}`.toLowerCase();
        if (/filesystem|file_system|file|directory|folder|path|read_file|write_file/.test(text)) {
            summary.filesystem = true;
        }
        if (/shell|command|terminal|exec|spawn/.test(text)) {
            summary.shell = true;
        }
        if (/web|search|browser|fetch|internet|serp|http/.test(text)) {
            summary.web = true;
        }
        if (/reason|thinking|plan|analysis/.test(text)) {
            summary.reasoning = true;
        }
    }
    return summary;
}

export class McpRuntimeService {
    async loadToolBundle(): Promise<McpToolBundle> {
        const settings = await readUserSettings();
        const tools = await getMcpTools(settings.mcp.services);
        return {
            tools,
            capabilities: classifyCapabilities(tools),
        };
    }

    async getServiceStatuses() {
        const settings = await readUserSettings();
        return mcpServiceManager.getServiceStatuses(settings.mcp.services);
    }
}

const globalState = globalThis as unknown as {
    __catGptMcpRuntimeService?: McpRuntimeService;
};

export const mcpRuntimeService = globalState.__catGptMcpRuntimeService
    || new McpRuntimeService();

if (!globalState.__catGptMcpRuntimeService) {
    globalState.__catGptMcpRuntimeService = mcpRuntimeService;
}
