export const RUNTIME_LIFECYCLE_HOOKS = [
    "prompt_before",
    "prompt_after",
    "tool_before",
    "tool_after",
    "response_stream",
    "error_format",
    "run_end",
] as const;

export type RuntimeLifecycleHookName = typeof RUNTIME_LIFECYCLE_HOOKS[number];

export interface RuntimeHookBaseEvent {
    runId: string;
    agentId?: string;
    timestamp: number;
    metadata?: Record<string, unknown>;
}

export interface RuntimePromptBeforeEvent extends RuntimeHookBaseEvent {
    systemPrompt: string;
    userPrompt: string;
    contextMessages: Array<{
        role: "system" | "user" | "assistant" | "tool";
        content: string;
    }>;
    systemPromptAppendices?: string[];
}

export interface RuntimePromptAfterEvent extends RuntimeHookBaseEvent {
    prompt: string;
}

export interface RuntimeToolBeforeEvent extends RuntimeHookBaseEvent {
    toolId: string;
    toolName: string;
    args: unknown;
}

export interface RuntimeToolAfterEvent extends RuntimeHookBaseEvent {
    toolId: string;
    toolName: string;
    args: unknown;
    result: unknown;
    durationMs: number;
}

export interface RuntimeResponseStreamEvent extends RuntimeHookBaseEvent {
    chunk: string;
    chunkIndex: number;
}

export interface RuntimeErrorFormatEvent extends RuntimeHookBaseEvent {
    error: unknown;
    formattedMessage?: string;
}

export interface RuntimeRunEndEvent extends RuntimeHookBaseEvent {
    status: "completed" | "failed" | "cancelled";
    durationMs: number;
    output?: string;
}

export interface RuntimeLifecycleHookEventMap {
    prompt_before: RuntimePromptBeforeEvent;
    prompt_after: RuntimePromptAfterEvent;
    tool_before: RuntimeToolBeforeEvent;
    tool_after: RuntimeToolAfterEvent;
    response_stream: RuntimeResponseStreamEvent;
    error_format: RuntimeErrorFormatEvent;
    run_end: RuntimeRunEndEvent;
}

export type RuntimeLifecycleHookHandler<K extends RuntimeLifecycleHookName = RuntimeLifecycleHookName> = (
    event: RuntimeLifecycleHookEventMap[K],
) => void | Promise<void>;

export interface RuntimeHookRegistrationOptions {
    id?: string;
    priority?: number;
}
