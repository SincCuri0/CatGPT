import { Tool, ToolInputSchema } from "../types";

const DEFAULT_SCHEMA: ToolInputSchema = {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: true,
};

export function normalizeToolDefinition(tool: Tool): Tool {
    const schema = tool.inputSchema ?? tool.parameters ?? DEFAULT_SCHEMA;

    return {
        ...tool,
        inputSchema: {
            type: "object",
            properties: schema.properties ?? {},
            required: schema.required ?? [],
            additionalProperties: schema.additionalProperties ?? true,
        },
        parameters: {
            type: "object",
            properties: schema.properties ?? {},
            required: schema.required ?? [],
            additionalProperties: schema.additionalProperties ?? true,
        },
    };
}
