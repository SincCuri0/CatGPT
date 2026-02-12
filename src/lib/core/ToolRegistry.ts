import { Tool } from "./types";

export class ToolRegistry {
    private tools: Map<string, Tool> = new Map();

    register(tool: Tool) {
        if (this.tools.has(tool.id)) {
            console.warn(`Tool with ID ${tool.id} is already registered. Overwriting.`);
        }
        this.tools.set(tool.id, tool);
    }

    get(id: string): Tool | undefined {
        return this.tools.get(id);
    }

    getAll(): Tool[] {
        return Array.from(this.tools.values());
    }

    getToolsByIds(ids: string[]): Tool[] {
        return ids.map(id => this.get(id)).filter((t): t is Tool => t !== undefined);
    }
}

export const toolRegistry = new ToolRegistry();
