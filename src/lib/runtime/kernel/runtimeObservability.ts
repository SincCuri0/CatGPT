import { NextRequest, NextResponse } from "next/server";
import { debugRouteError, debugRouteLog } from "@/lib/debug/server";
import { runtimeObservabilityService } from "@/lib/runtime/services/observabilityService";
import { runtimeTaskSchedulerService } from "@/lib/runtime/services/taskSchedulerService";
import { runtimeStateSyncService } from "@/lib/runtime/services/stateSyncService";
import { isRecord } from "@/lib/runtime/kernel/validation";
import { authorizeRuntimeAccess } from "@/lib/security/runtimeAccess";

function sanitizeLimit(value: string | null, fallback = 200): number {
    if (!value) return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(1, Math.min(2_000, Math.floor(parsed)));
}

export async function executeRuntimeObservabilityGet(req: NextRequest, debugEnabled: boolean): Promise<Response> {
    try {
        const access = authorizeRuntimeAccess(req);
        if (!access.ok) {
            debugRouteLog(debugEnabled, "api/runtime/observability", "Rejected runtime access", { reason: access.reason });
            return NextResponse.json({ error: access.reason || "Unauthorized" }, { status: 401 });
        }

        const { searchParams } = new URL(req.url);
        const limit = sanitizeLimit(searchParams.get("limit"));
        const tasks = await runtimeTaskSchedulerService.list({ limit: 200 });
        const runningTasks = tasks.filter((task) => task.status === "running").length;
        const queuedTasks = tasks.filter((task) => task.status === "queued").length;
        const failedTasks = tasks.filter((task) => task.status === "failed").length;

        const snapshot = runtimeObservabilityService.snapshot(limit);
        const channels = runtimeStateSyncService.listChannels();
        debugRouteLog(debugEnabled, "api/runtime/observability", "Resolved runtime observability snapshot", {
            counterCount: snapshot.counters.length,
            stateChannels: channels.length,
            runningTasks,
        });

        return NextResponse.json({
            metrics: snapshot,
            scheduler: {
                totalTasks: tasks.length,
                queuedTasks,
                runningTasks,
                failedTasks,
            },
            stateSync: {
                channels,
            },
        });
    } catch (error: unknown) {
        debugRouteError(debugEnabled, "api/runtime/observability", "Unhandled error in GET", error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unknown error" },
            { status: 500 },
        );
    }
}

export async function executeRuntimeObservabilityPost(req: NextRequest, debugEnabled: boolean): Promise<Response> {
    try {
        const access = authorizeRuntimeAccess(req);
        if (!access.ok) {
            debugRouteLog(debugEnabled, "api/runtime/observability", "Rejected runtime access", { reason: access.reason });
            return NextResponse.json({ error: access.reason || "Unauthorized" }, { status: 401 });
        }

        const body = await req.json();
        if (!isRecord(body) || typeof body.action !== "string") {
            return NextResponse.json({ error: "Invalid Request: missing action" }, { status: 400 });
        }
        if (body.action === "clear") {
            runtimeObservabilityService.clear();
            if (body.clearStateSync === true) {
                runtimeStateSyncService.clear();
            }
            return NextResponse.json({ ok: true });
        }
        return NextResponse.json({ error: `Unsupported action '${body.action}'.` }, { status: 400 });
    } catch (error: unknown) {
        debugRouteError(debugEnabled, "api/runtime/observability", "Unhandled error in POST", error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unknown error" },
            { status: 500 },
        );
    }
}
