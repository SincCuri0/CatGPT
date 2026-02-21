import type { RuntimeHookRegistry } from "@/lib/runtime/hooks/registry";
import type { RuntimeEventBus } from "@/lib/runtime/infrastructure/events";

export interface RuntimeServiceLogger {
    debug: (message: string, details?: Record<string, unknown>) => void;
    info: (message: string, details?: Record<string, unknown>) => void;
    warn: (message: string, details?: Record<string, unknown>) => void;
    error: (message: string, details?: Record<string, unknown>) => void;
}

export interface RuntimeServiceHealth {
    ok: boolean;
    updatedAt: number;
    details?: Record<string, unknown>;
}

export interface RuntimeServiceContext<TEvents extends Record<string, unknown> = Record<string, unknown>> {
    hooks: RuntimeHookRegistry;
    events: RuntimeEventBus<TEvents>;
    clock: () => number;
    logger?: RuntimeServiceLogger;
    metadata?: Record<string, unknown>;
}

export interface RuntimeService<TEvents extends Record<string, unknown> = Record<string, unknown>> {
    id: string;
    start: (context: RuntimeServiceContext<TEvents>) => Promise<void> | void;
    stop?: (context: RuntimeServiceContext<TEvents>) => Promise<void> | void;
    health?: (context: RuntimeServiceContext<TEvents>) => Promise<RuntimeServiceHealth> | RuntimeServiceHealth;
}

