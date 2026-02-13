export interface Message {
    id: string;
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    name?: string; // name of the agent or tool
    agentId?: string;
    agentStyle?: "assistant" | "character" | "expert" | "custom";
    voiceId?: string;
    autoPlay?: boolean;
    typewriter?: boolean;
    timestamp: number;
}

export type ToolSchemaPrimitiveType =
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "array"
    | "object";

export interface ToolSchemaProperty {
    type?: ToolSchemaPrimitiveType;
    description?: string;
    enum?: string[] | number[] | boolean[];
    items?: Record<string, unknown>;
    properties?: Record<string, unknown>;
    required?: string[];
}

export interface ToolInputSchema {
    type: "object";
    properties: Record<string, ToolSchemaProperty>;
    required?: string[];
    additionalProperties?: boolean;
}

export interface ToolExecutionContext {
    agentId?: string;
    agentName?: string;
    providerId?: string;
    squadId?: string;
}

export interface Tool {
    id: string;
    name: string;
    description: string;
    inputSchema?: ToolInputSchema;
    // Backward compatibility for existing tool definitions.
    parameters?: ToolInputSchema;
    execute: (args: unknown, context?: ToolExecutionContext) => Promise<string>;
}
