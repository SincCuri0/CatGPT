export type RuntimeEventHandler<TPayload> = (payload: TPayload) => void | Promise<void>;

type EventNameMap = Record<string, unknown>;

type HandlerStore<TEvents extends EventNameMap> = {
    [K in keyof TEvents]?: Map<string, RuntimeEventHandler<TEvents[K]>>;
};

function makeHandlerId(eventName: string): string {
    return `${eventName}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

export class RuntimeEventBus<TEvents extends EventNameMap> {
    private readonly handlers: HandlerStore<TEvents> = {};

    on<K extends keyof TEvents & string>(
        eventName: K,
        handler: RuntimeEventHandler<TEvents[K]>,
        handlerId?: string,
    ): () => void {
        const id = handlerId || makeHandlerId(eventName);
        const existing = this.handlers[eventName];
        if (existing) {
            existing.set(id, handler);
        } else {
            this.handlers[eventName] = new Map([[id, handler]]);
        }

        return () => this.off(eventName, id);
    }

    off<K extends keyof TEvents & string>(eventName: K, handlerId: string): void {
        const bucket = this.handlers[eventName];
        if (!bucket) return;
        bucket.delete(handlerId);
        if (bucket.size === 0) {
            delete this.handlers[eventName];
        }
    }

    async emit<K extends keyof TEvents & string>(eventName: K, payload: TEvents[K]): Promise<void> {
        const bucket = this.handlers[eventName];
        if (!bucket || bucket.size === 0) return;
        for (const handler of bucket.values()) {
            await handler(payload);
        }
    }

    clear(eventName?: keyof TEvents & string): void {
        if (eventName) {
            delete this.handlers[eventName];
            return;
        }
        for (const key of Object.keys(this.handlers)) {
            delete this.handlers[key as keyof TEvents & string];
        }
    }

    listenerCount(eventName?: keyof TEvents & string): number {
        if (eventName) {
            return this.handlers[eventName]?.size ?? 0;
        }
        return Object.values(this.handlers).reduce((sum, bucket) => sum + (bucket?.size ?? 0), 0);
    }
}

