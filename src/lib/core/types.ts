export interface Message {
    id: string;
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    name?: string; // name of the agent or tool
    timestamp: number;
}

export interface ToolArgument {
    name: string;
    type: "string" | "number" | "boolean";
    description: string;
    required?: boolean;
}

export interface Tool {
    id: string;
    name: string;
    description: string;
    parameters: {
        type: "object";
        properties: Record<string, any>;
        required: string[];
    };
    execute: (args: any, context?: any) => Promise<string>;
}
