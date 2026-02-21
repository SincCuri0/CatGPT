import type { RuntimeHookRegistry } from "@/lib/runtime/hooks/registry";

export interface ObservabilityCounterSnapshot {
    key: string;
    value: number;
}

export interface RuntimeObservabilitySnapshot {
    counters: ObservabilityCounterSnapshot[];
    lastUpdatedAt: number;
}

function buildCounterKey(metric: string, tags?: Record<string, string>): string {
    if (!tags || Object.keys(tags).length === 0) return metric;
    const normalizedTags = Object.entries(tags)
        .map(([key, value]) => `${key}:${value}`)
        .sort((left, right) => left.localeCompare(right))
        .join("|");
    return `${metric}|${normalizedTags}`;
}

export class RuntimeObservabilityService {
    private readonly counters = new Map<string, number>();
    private lastUpdatedAt = Date.now();

    increment(metric: string, amount = 1, tags?: Record<string, string>): void {
        const key = buildCounterKey(metric, tags);
        this.counters.set(key, (this.counters.get(key) || 0) + amount);
        this.lastUpdatedAt = Date.now();
    }

    snapshot(limit = 500): RuntimeObservabilitySnapshot {
        const counters = Array.from(this.counters.entries())
            .sort((left, right) => right[1] - left[1])
            .slice(0, Math.max(1, Math.min(2_000, Math.floor(limit))))
            .map(([key, value]) => ({ key, value }));
        return {
            counters,
            lastUpdatedAt: this.lastUpdatedAt,
        };
    }

    clear(): void {
        this.counters.clear();
        this.lastUpdatedAt = Date.now();
    }
}

export function registerObservabilityHooks(
    registry: RuntimeHookRegistry,
    service: RuntimeObservabilityService,
): void {
    registry.register("prompt_before", (event) => {
        service.increment("runs.prompt_before");
        service.increment("runs.prompt_context_messages", event.contextMessages.length);
    }, { id: "observability-prompt-before", priority: 80 });

    registry.register("tool_before", (event) => {
        service.increment("tools.started");
        service.increment("tools.started.by_tool", 1, { toolId: event.toolId });
    }, { id: "observability-tool-before", priority: 80 });

    registry.register("tool_after", (event) => {
        service.increment("tools.completed");
        service.increment("tools.duration_ms.total", Math.max(0, event.durationMs));
        const result = event.result as { ok?: unknown } | null;
        const outcome = typeof result?.ok === "boolean" && result.ok ? "ok" : "error";
        service.increment(`tools.completed.${outcome}`);
    }, { id: "observability-tool-after", priority: 80 });

    registry.register("run_end", (event) => {
        service.increment("runs.completed");
        service.increment("runs.duration_ms.total", Math.max(0, event.durationMs));
        service.increment(`runs.completed.${event.status}`);
    }, { id: "observability-run-end", priority: 80 });

    registry.register("error_format", () => {
        service.increment("runs.errors");
    }, { id: "observability-error-format", priority: 80 });
}

const globalState = globalThis as unknown as {
    __catGptRuntimeObservabilityService?: RuntimeObservabilityService;
};

export const runtimeObservabilityService = globalState.__catGptRuntimeObservabilityService
    || new RuntimeObservabilityService();

if (!globalState.__catGptRuntimeObservabilityService) {
    globalState.__catGptRuntimeObservabilityService = runtimeObservabilityService;
}
