import type { RuntimeLifecycleHookName } from "@/lib/runtime/hooks/types";

export type RuntimeRunStatus =
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "cancelled";

export interface RuntimeRunDescriptor {
    runId: string;
    agentId: string;
    agentName: string;
    startedAt: number;
    status: RuntimeRunStatus;
    metadata?: Record<string, unknown>;
}

export interface RuntimeKernelCapabilities {
    supportsStreaming: boolean;
    supportsToolCalls: boolean;
    lifecycleHooks: RuntimeLifecycleHookName[];
}

