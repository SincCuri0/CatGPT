import {
    RUNTIME_LIFECYCLE_HOOKS,
    RuntimeHookRegistrationOptions,
    RuntimeLifecycleHookEventMap,
    RuntimeLifecycleHookHandler,
    RuntimeLifecycleHookName,
} from "@/lib/runtime/hooks/types";

interface RuntimeHookHandlerEntry<K extends RuntimeLifecycleHookName> {
    id: string;
    priority: number;
    handler: RuntimeLifecycleHookHandler<K>;
}

type RuntimeHookStore = {
    [K in RuntimeLifecycleHookName]: Array<RuntimeHookHandlerEntry<K>>;
};

function makeHookId(hook: RuntimeLifecycleHookName): string {
    return `${hook}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

export class RuntimeHookRegistry {
    private readonly handlers: RuntimeHookStore;

    constructor() {
        this.handlers = {
            prompt_before: [],
            prompt_after: [],
            tool_before: [],
            tool_after: [],
            response_stream: [],
            error_format: [],
            run_end: [],
        };
    }

    register<K extends RuntimeLifecycleHookName>(
        hook: K,
        handler: RuntimeLifecycleHookHandler<K>,
        options?: RuntimeHookRegistrationOptions,
    ): () => void {
        const id = options?.id || makeHookId(hook);
        const priority = Number.isFinite(options?.priority) ? Number(options?.priority) : 0;
        const bucket = this.handlers[hook] as Array<RuntimeHookHandlerEntry<K>>;
        bucket.push({ id, priority, handler });
        bucket.sort((left, right) => left.priority - right.priority);

        return () => {
            const current = this.handlers[hook] as Array<RuntimeHookHandlerEntry<K>>;
            const index = current.findIndex((entry) => entry.id === id);
            if (index >= 0) {
                current.splice(index, 1);
            }
        };
    }

    async emit<K extends RuntimeLifecycleHookName>(
        hook: K,
        event: RuntimeLifecycleHookEventMap[K],
    ): Promise<void> {
        const bucket = this.handlers[hook] as Array<RuntimeHookHandlerEntry<K>>;
        for (const entry of bucket) {
            await entry.handler(event);
        }
    }

    clear(hook?: RuntimeLifecycleHookName): void {
        if (hook) {
            this.handlers[hook] = [];
            return;
        }
        for (const name of RUNTIME_LIFECYCLE_HOOKS) {
            this.handlers[name] = [];
        }
    }

    getRegisteredCounts(): Record<RuntimeLifecycleHookName, number> {
        return {
            prompt_before: this.handlers.prompt_before.length,
            prompt_after: this.handlers.prompt_after.length,
            tool_before: this.handlers.tool_before.length,
            tool_after: this.handlers.tool_after.length,
            response_stream: this.handlers.response_stream.length,
            error_format: this.handlers.error_format.length,
            run_end: this.handlers.run_end.length,
        };
    }
}

