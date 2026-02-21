export interface RuntimeStateEvent {
    channel: string;
    seq: number;
    version: number;
    type: string;
    status: string;
    timestamp: number;
    payload: Record<string, unknown>;
}

export interface RuntimeStateSnapshot {
    channel: string;
    seq: number;
    version: number;
    status: string;
    updatedAt: number;
    payload: Record<string, unknown>;
}

interface RuntimeStateChannelData {
    snapshot: RuntimeStateSnapshot;
    events: RuntimeStateEvent[];
    listeners: Map<string, (event: RuntimeStateEvent) => void>;
}

const MAX_EVENTS_PER_CHANNEL = 300;

function normalizeChannel(channel: string): string {
    const normalized = channel.trim().toLowerCase();
    return normalized || "default";
}

function sanitizeLimit(limit: number | undefined, fallback = 100): number {
    const candidate = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : fallback;
    return Math.max(1, Math.min(1_000, candidate));
}

function makeListenerId(channel: string): string {
    return `${channel}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

export class RuntimeStateSyncService {
    private readonly channels = new Map<string, RuntimeStateChannelData>();

    private getOrCreateChannel(channel: string): RuntimeStateChannelData {
        const normalized = normalizeChannel(channel);
        const existing = this.channels.get(normalized);
        if (existing) return existing;

        const created: RuntimeStateChannelData = {
            snapshot: {
                channel: normalized,
                seq: 0,
                version: 1,
                status: "idle",
                updatedAt: Date.now(),
                payload: {},
            },
            events: [],
            listeners: new Map(),
        };
        this.channels.set(normalized, created);
        return created;
    }

    publish(
        channel: string,
        eventType: string,
        payload: Record<string, unknown>,
        status = "active",
    ): RuntimeStateEvent {
        const channelData = this.getOrCreateChannel(channel);
        const seq = channelData.snapshot.seq + 1;
        const version = channelData.snapshot.version + 1;
        const now = Date.now();
        const event: RuntimeStateEvent = {
            channel: channelData.snapshot.channel,
            seq,
            version,
            type: eventType,
            status,
            timestamp: now,
            payload,
        };

        channelData.snapshot = {
            channel: channelData.snapshot.channel,
            seq,
            version,
            status,
            updatedAt: now,
            payload,
        };
        channelData.events.push(event);
        if (channelData.events.length > MAX_EVENTS_PER_CHANNEL) {
            channelData.events.splice(0, channelData.events.length - MAX_EVENTS_PER_CHANNEL);
        }

        for (const listener of channelData.listeners.values()) {
            listener(event);
        }
        return event;
    }

    getSnapshot(channel: string): RuntimeStateSnapshot {
        const channelData = this.getOrCreateChannel(channel);
        return {
            ...channelData.snapshot,
            payload: { ...channelData.snapshot.payload },
        };
    }

    getEventsSince(channel: string, sinceSeq: number, limit?: number): RuntimeStateEvent[] {
        const channelData = this.getOrCreateChannel(channel);
        const safeLimit = sanitizeLimit(limit);
        return channelData.events
            .filter((event) => event.seq > sinceSeq)
            .slice(-safeLimit)
            .map((event) => ({
                ...event,
                payload: { ...event.payload },
            }));
    }

    subscribe(channel: string, listener: (event: RuntimeStateEvent) => void): () => void {
        const channelData = this.getOrCreateChannel(channel);
        const id = makeListenerId(channelData.snapshot.channel);
        channelData.listeners.set(id, listener);
        return () => {
            channelData.listeners.delete(id);
        };
    }

    listChannels(): string[] {
        return Array.from(this.channels.keys()).sort((left, right) => left.localeCompare(right));
    }

    clear(channel?: string): void {
        if (channel) {
            this.channels.delete(normalizeChannel(channel));
            return;
        }
        this.channels.clear();
    }
}

const globalState = globalThis as unknown as {
    __catGptRuntimeStateSyncService?: RuntimeStateSyncService;
};

export const runtimeStateSyncService = globalState.__catGptRuntimeStateSyncService
    || new RuntimeStateSyncService();

if (!globalState.__catGptRuntimeStateSyncService) {
    globalState.__catGptRuntimeStateSyncService = runtimeStateSyncService;
}
