"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, RefreshCcw, Timer, X } from "lucide-react";

interface RuntimeInspectorPanelProps {
    activeAgentId?: string | null;
    debugLogsEnabled: boolean;
}

interface RuntimeObservabilityResponse {
    metrics?: {
        counters?: Array<{ key: string; value: number }>;
        lastUpdatedAt?: number;
    };
    scheduler?: {
        totalTasks?: number;
        queuedTasks?: number;
        runningTasks?: number;
        failedTasks?: number;
    };
    stateSync?: {
        channels?: string[];
    };
    error?: string;
}

interface RuntimeTasksResponse {
    tasks?: Array<{
        id: string;
        kind: "adhoc" | "planned" | "cron";
        status: "queued" | "running" | "completed" | "failed" | "cancelled";
        updatedAt: number;
        context?: Record<string, string>;
        lastError?: string;
    }>;
    error?: string;
}

interface RuntimeStateResponse {
    channel?: string;
    snapshot?: {
        seq: number;
        version: number;
        status: string;
        updatedAt: number;
    };
    events?: Array<{
        seq: number;
        type: string;
        status: string;
        timestamp: number;
        payload: Record<string, unknown>;
    }>;
    error?: string;
}

function toTimeLabel(timestamp?: number): string {
    if (!timestamp || !Number.isFinite(timestamp)) return "n/a";
    return new Date(timestamp).toLocaleTimeString();
}

const RUNTIME_TOKEN_STORAGE_KEY = "cat_gpt_runtime_admin_token";

function headers(debugLogsEnabled: boolean): HeadersInit | undefined {
    const out: Record<string, string> = {};
    if (debugLogsEnabled) {
        out["x-debug-logs"] = "1";
    }
    if (typeof window !== "undefined") {
        const token = localStorage.getItem(RUNTIME_TOKEN_STORAGE_KEY)?.trim();
        if (token) {
            out["x-runtime-token"] = token;
        }
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

export function RuntimeInspectorPanel({ activeAgentId, debugLogsEnabled }: RuntimeInspectorPanelProps) {
    const [open, setOpen] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [observability, setObservability] = useState<RuntimeObservabilityResponse | null>(null);
    const [tasks, setTasks] = useState<RuntimeTasksResponse | null>(null);
    const [state, setState] = useState<RuntimeStateResponse | null>(null);
    const [lastRefreshAt, setLastRefreshAt] = useState<number>(0);

    const load = useCallback(async () => {
        if (!open) return;
        setIsLoading(true);
        setError(null);
        try {
            const reqHeaders = headers(debugLogsEnabled);
            const observabilityPromise = fetch("/api/runtime/observability?limit=30", {
                headers: reqHeaders,
            });
            const tasksPromise = fetch("/api/runtime/tasks?limit=20&status=queued,running,failed", {
                headers: reqHeaders,
            });
            const statePromise = activeAgentId
                ? fetch(`/api/runtime/state?agentId=${encodeURIComponent(activeAgentId)}&since=0&limit=12`, {
                    headers: reqHeaders,
                })
                : Promise.resolve(null);

            const [obsRes, tasksRes, stateRes] = await Promise.all([
                observabilityPromise,
                tasksPromise,
                statePromise,
            ]);

            if (!obsRes.ok) {
                const payload = await obsRes.json().catch(() => ({ error: "Failed to load runtime observability." }));
                throw new Error(payload.error || "Failed to load runtime observability.");
            }
            if (!tasksRes.ok) {
                const payload = await tasksRes.json().catch(() => ({ error: "Failed to load runtime tasks." }));
                throw new Error(payload.error || "Failed to load runtime tasks.");
            }
            if (stateRes && !stateRes.ok) {
                const payload = await stateRes.json().catch(() => ({ error: "Failed to load runtime state." }));
                throw new Error(payload.error || "Failed to load runtime state.");
            }

            const [obsJson, tasksJson, stateJson] = await Promise.all([
                obsRes.json() as Promise<RuntimeObservabilityResponse>,
                tasksRes.json() as Promise<RuntimeTasksResponse>,
                stateRes ? stateRes.json() as Promise<RuntimeStateResponse> : Promise.resolve(null),
            ]);

            setObservability(obsJson);
            setTasks(tasksJson);
            setState(stateJson);
            setLastRefreshAt(Date.now());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : "Failed to load runtime diagnostics.";
            setError(message);
        } finally {
            setIsLoading(false);
        }
    }, [activeAgentId, debugLogsEnabled, open]);

    useEffect(() => {
        if (!open) return;
        void load();
        const intervalId = window.setInterval(() => {
            void load();
        }, 5000);
        return () => {
            window.clearInterval(intervalId);
        };
    }, [load, open]);

    const topCounters = useMemo(() => {
        const items = Array.isArray(observability?.metrics?.counters) ? observability?.metrics?.counters : [];
        return items.slice(0, 8);
    }, [observability?.metrics?.counters]);

    const visibleTasks = useMemo(() => {
        const items = Array.isArray(tasks?.tasks) ? tasks.tasks : [];
        return items.slice(0, 8);
    }, [tasks?.tasks]);

    const recentEvents = useMemo(() => {
        const items = Array.isArray(state?.events) ? state.events : [];
        return items.slice(-8).reverse();
    }, [state?.events]);

    return (
        <>
            <button
                type="button"
                onClick={() => setOpen((prev) => !prev)}
                className="fixed bottom-5 right-5 z-[130] inline-flex items-center gap-2 rounded-lg border border-[#7aa2f7]/35 bg-[#171717]/95 px-3 py-2 text-xs font-medium text-[#c0caf5] shadow-xl backdrop-blur-sm hover:bg-[#1f1f1f] transition-colors"
                title="Runtime Inspector"
            >
                <Activity size={14} />
                Runtime
            </button>

            {open && (
                <div className="fixed bottom-20 right-5 z-[130] w-[420px] max-w-[calc(100vw-2rem)] max-h-[75vh] overflow-hidden rounded-xl border border-white/10 bg-[#171717] shadow-2xl">
                    <div className="flex items-center justify-between border-b border-white/10 bg-[#1f1f1f] px-3 py-2">
                        <div className="min-w-0">
                            <div className="text-sm font-semibold text-white">Runtime Inspector</div>
                            <div className="text-[11px] text-[#8e8ea0] truncate">
                                Agent: {activeAgentId || "none"} · Refreshed {toTimeLabel(lastRefreshAt)}
                            </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                            <button
                                type="button"
                                onClick={() => void load()}
                                className="rounded-md border border-white/10 p-1.5 text-[#8e8ea0] hover:text-white hover:bg-[#2a2a2a]"
                                title="Refresh"
                            >
                                <RefreshCcw size={13} className={isLoading ? "animate-spin" : ""} />
                            </button>
                            <button
                                type="button"
                                onClick={() => setOpen(false)}
                                className="rounded-md border border-white/10 p-1.5 text-[#8e8ea0] hover:text-white hover:bg-[#2a2a2a]"
                                title="Close"
                            >
                                <X size={13} />
                            </button>
                        </div>
                    </div>

                    <div className="space-y-3 overflow-y-auto p-3 custom-scrollbar max-h-[calc(75vh-52px)]">
                        {error && (
                            <div className="rounded-md border border-red-500/25 bg-red-500/10 p-2 text-xs text-red-200">
                                {error}
                            </div>
                        )}

                        <div className="rounded-lg border border-white/10 bg-[#202020] p-2.5">
                            <div className="mb-1 text-[11px] uppercase tracking-wide text-[#8e8ea0]">Scheduler</div>
                            <div className="grid grid-cols-2 gap-2 text-xs text-[#d4d4d8]">
                                <div>Total: {observability?.scheduler?.totalTasks ?? 0}</div>
                                <div>Queued: {observability?.scheduler?.queuedTasks ?? 0}</div>
                                <div>Running: {observability?.scheduler?.runningTasks ?? 0}</div>
                                <div>Failed: {observability?.scheduler?.failedTasks ?? 0}</div>
                            </div>
                        </div>

                        <div className="rounded-lg border border-white/10 bg-[#202020] p-2.5">
                            <div className="mb-1 text-[11px] uppercase tracking-wide text-[#8e8ea0]">Top Counters</div>
                            {topCounters.length === 0 ? (
                                <div className="text-xs text-[#8e8ea0]">No counters yet.</div>
                            ) : (
                                <div className="space-y-1">
                                    {topCounters.map((counter) => (
                                        <div key={counter.key} className="flex items-center justify-between gap-2 text-xs">
                                            <span className="truncate text-[#c0caf5]" title={counter.key}>{counter.key}</span>
                                            <span className="text-[#9ece6a]">{counter.value}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        <div className="rounded-lg border border-white/10 bg-[#202020] p-2.5">
                            <div className="mb-1 text-[11px] uppercase tracking-wide text-[#8e8ea0]">Active Tasks</div>
                            {visibleTasks.length === 0 ? (
                                <div className="text-xs text-[#8e8ea0]">No queued/running/failed tasks.</div>
                            ) : (
                                <div className="space-y-1.5">
                                    {visibleTasks.map((task) => (
                                        <div key={task.id} className="rounded border border-white/10 bg-[#181818] p-2">
                                            <div className="flex items-center justify-between gap-2 text-xs">
                                                <span className="truncate text-[#ececec]" title={task.id}>{task.id}</span>
                                                <span className="text-[#8e8ea0]">{task.kind}</span>
                                            </div>
                                            <div className="mt-1 flex items-center justify-between text-[11px]">
                                                <span className="text-[#7aa2f7]">{task.status}</span>
                                                <span className="text-[#8e8ea0]">{toTimeLabel(task.updatedAt)}</span>
                                            </div>
                                            {task.lastError && (
                                                <div className="mt-1 text-[11px] text-red-300 line-clamp-2">{task.lastError}</div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        <div className="rounded-lg border border-white/10 bg-[#202020] p-2.5">
                            <div className="mb-1 flex items-center justify-between">
                                <span className="text-[11px] uppercase tracking-wide text-[#8e8ea0]">Agent State Events</span>
                                <span className="text-[10px] text-[#8e8ea0]">
                                    seq {state?.snapshot?.seq ?? 0} · v{state?.snapshot?.version ?? 0}
                                </span>
                            </div>
                            {recentEvents.length === 0 ? (
                                <div className="text-xs text-[#8e8ea0]">No events for this agent channel yet.</div>
                            ) : (
                                <div className="space-y-1.5">
                                    {recentEvents.map((event) => (
                                        <div key={`${event.seq}-${event.type}`} className="rounded border border-white/10 bg-[#181818] p-2">
                                            <div className="flex items-center justify-between gap-2 text-xs">
                                                <span className="truncate text-[#ececec]">{event.type}</span>
                                                <span className="text-[#8e8ea0]">#{event.seq}</span>
                                            </div>
                                            <div className="mt-1 flex items-center gap-1 text-[11px] text-[#8e8ea0]">
                                                <Timer size={10} />
                                                {toTimeLabel(event.timestamp)} · {event.status}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
