import { NextRequest, NextResponse } from "next/server";
import { debugRouteError, debugRouteLog } from "@/lib/debug/server";
import { runtimeStateSyncService } from "@/lib/runtime/services/stateSyncService";
import { authorizeRuntimeAccess } from "@/lib/security/runtimeAccess";

function sanitizeInteger(value: string | null, fallback: number): number {
    if (!value) return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(0, Math.floor(parsed));
}

function resolveChannel(params: URLSearchParams): string | null {
    const explicit = params.get("channel");
    if (explicit && explicit.trim()) {
        return explicit.trim().toLowerCase();
    }
    const runId = params.get("runId");
    if (runId && runId.trim()) {
        return `run:${runId.trim().toLowerCase()}`;
    }
    const agentId = params.get("agentId");
    if (agentId && agentId.trim()) {
        return `agent:${agentId.trim().toLowerCase()}`;
    }
    return null;
}

function serializeSse(payload: unknown, eventName = "message"): string {
    return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export async function executeRuntimeStateGet(req: NextRequest, debugEnabled: boolean): Promise<Response> {
    try {
        const access = authorizeRuntimeAccess(req);
        if (!access.ok) {
            debugRouteLog(debugEnabled, "api/runtime/state", "Rejected runtime access", { reason: access.reason });
            return NextResponse.json({ error: access.reason || "Unauthorized" }, { status: 401 });
        }

        const { searchParams } = new URL(req.url);
        const channel = resolveChannel(searchParams);
        if (!channel) {
            return NextResponse.json({
                channels: runtimeStateSyncService.listChannels(),
            });
        }

        const since = sanitizeInteger(searchParams.get("since"), 0);
        const limit = sanitizeInteger(searchParams.get("limit"), 100);
        const stream = searchParams.get("stream") === "1";

        const snapshot = runtimeStateSyncService.getSnapshot(channel);
        const events = runtimeStateSyncService.getEventsSince(channel, since, limit);
        debugRouteLog(debugEnabled, "api/runtime/state", "Resolved state snapshot", {
            channel,
            since,
            returnedEvents: events.length,
            snapshotSeq: snapshot.seq,
        });

        if (!stream) {
            return NextResponse.json({
                channel,
                snapshot,
                events,
            });
        }

        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode(serializeSse({ channel, snapshot, events }, "snapshot")));
                const unsubscribe = runtimeStateSyncService.subscribe(channel, (event) => {
                    controller.enqueue(encoder.encode(serializeSse(event, "event")));
                });
                const heartbeat = setInterval(() => {
                    controller.enqueue(encoder.encode(": heartbeat\n\n"));
                }, 15_000);

                const close = () => {
                    clearInterval(heartbeat);
                    unsubscribe();
                    try {
                        controller.close();
                    } catch {
                        // Stream already closed.
                    }
                };

                req.signal.addEventListener("abort", close);
            },
        });

        return new Response(body, {
            headers: {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
            },
        });
    } catch (error: unknown) {
        debugRouteError(debugEnabled, "api/runtime/state", "Unhandled error in GET", error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unknown error" },
            { status: 500 },
        );
    }
}
