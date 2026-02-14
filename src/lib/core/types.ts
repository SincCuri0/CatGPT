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
    error?: boolean;
    toolExecution?: {
        attempted: number;
        succeeded: number;
        failed: number;
        malformed: number;
        verifiedFileEffects: number;
        verifiedShellEffects: number;
    };
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
    squadName?: string;
    runId?: string;
    toolAccessMode?: "ask_always" | "full_access";
    toolAccessGranted?: boolean;
    spawnSubAgent?: (request: SubAgentSpawnRequest) => Promise<SubAgentRunState>;
    awaitSubAgentRun?: (runId: string, timeoutMs?: number) => Promise<SubAgentRunState | null>;
    listSubAgentRuns?: () => Promise<SubAgentRunState[]>;
    cancelSubAgentRun?: (runId: string, reason?: string) => Promise<SubAgentRunState | null>;
}

export type ToolArtifactKind = "file" | "shell" | "web" | "other";

export interface ToolArtifact {
    kind: ToolArtifactKind;
    label: string;
    operation?: string;
    path?: string;
    metadata?: Record<string, unknown>;
}

export interface ToolCheck {
    id: string;
    ok: boolean;
    description: string;
    details?: string;
}

export interface ToolResult {
    ok: boolean;
    output?: string;
    error?: string;
    artifacts: ToolArtifact[];
    checks: ToolCheck[];
}

export interface SubAgentSpawnRequest {
    task: string;
    agentId?: string;
    provider?: string;
    model?: string;
    awaitCompletion?: boolean;
    timeoutMs?: number;
}

export interface SubAgentRunState {
    runId: string;
    parentRunId?: string;
    status: "queued" | "running" | "completed" | "failed" | "cancelled";
    agentId: string;
    agentName: string;
    task: string;
    createdAt: number;
    startedAt?: number;
    finishedAt?: number;
    output?: string;
    error?: string;
}

export interface Tool {
    id: string;
    name: string;
    description: string;
    privileged?: boolean;
    inputSchema?: ToolInputSchema;
    // Backward compatibility for existing tool definitions.
    parameters?: ToolInputSchema;
    execute: (args: unknown, context?: ToolExecutionContext) => Promise<ToolResult>;
}
