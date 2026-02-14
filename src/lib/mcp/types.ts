import type { ToolInputSchema } from "@/lib/core/types";

export type McpTransportType = "stdio";

export interface McpServiceConfig {
    id: string;
    name: string;
    description?: string;
    enabled: boolean;
    transport: McpTransportType;
    command: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
}

export interface McpSettings {
    services: McpServiceConfig[];
}

export interface McpToolDescriptor {
    id: string;
    serviceId: string;
    serviceName: string;
    toolName: string;
    displayName: string;
    description: string;
    inputSchema: ToolInputSchema;
    privileged: boolean;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
}

export interface McpServiceStatus {
    id: string;
    name: string;
    description?: string;
    enabled: boolean;
    command: string;
    args: string[];
    status: "disabled" | "idle" | "connecting" | "ready" | "error";
    error?: string;
    toolCount: number;
    tools: Array<{
        id: string;
        toolName: string;
        displayName: string;
        privileged: boolean;
    }>;
}
