import { NextRequest, NextResponse } from "next/server";
import { debugRouteError, debugRouteLog } from "@/lib/debug/server";
import { runtimeTaskSchedulerService } from "@/lib/runtime/services/taskSchedulerService";
import { isRecord } from "@/lib/runtime/kernel/validation";
import { authorizeRuntimeAccess } from "@/lib/security/runtimeAccess";

function sanitizeLimit(value: string | null, fallback: number): number {
    if (!value) return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(1, Math.min(500, Math.floor(parsed)));
}

function normalizeStatuses(value: string | null): Array<"queued" | "running" | "completed" | "failed" | "cancelled"> {
    if (!value) return [];
    return value
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry): entry is "queued" | "running" | "completed" | "failed" | "cancelled" => (
            entry === "queued"
            || entry === "running"
            || entry === "completed"
            || entry === "failed"
            || entry === "cancelled"
        ));
}

function normalizeKinds(value: string | null): Array<"adhoc" | "planned" | "cron"> {
    if (!value) return [];
    return value
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry): entry is "adhoc" | "planned" | "cron" => (
            entry === "adhoc" || entry === "planned" || entry === "cron"
        ));
}

export async function executeRuntimeTasksGet(req: NextRequest, debugEnabled: boolean): Promise<Response> {
    try {
        const access = authorizeRuntimeAccess(req);
        if (!access.ok) {
            debugRouteLog(debugEnabled, "api/runtime/tasks", "Rejected runtime access", { reason: access.reason });
            return NextResponse.json({ error: access.reason || "Unauthorized" }, { status: 401 });
        }

        const { searchParams } = new URL(req.url);
        const limit = sanitizeLimit(searchParams.get("limit"), 200);
        const status = normalizeStatuses(searchParams.get("status"));
        const kind = normalizeKinds(searchParams.get("kind"));
        const tasks = await runtimeTaskSchedulerService.list({
            limit,
            status: status.length > 0 ? status : undefined,
            kind: kind.length > 0 ? kind : undefined,
        });
        debugRouteLog(debugEnabled, "api/runtime/tasks", "Listed runtime tasks", {
            limit,
            statusCount: status.length,
            kindCount: kind.length,
            returned: tasks.length,
        });
        return NextResponse.json({ tasks });
    } catch (error: unknown) {
        debugRouteError(debugEnabled, "api/runtime/tasks", "Unhandled error in GET", error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unknown error" },
            { status: 500 },
        );
    }
}

export async function executeRuntimeTasksPost(req: NextRequest, debugEnabled: boolean): Promise<Response> {
    try {
        const access = authorizeRuntimeAccess(req);
        if (!access.ok) {
            debugRouteLog(debugEnabled, "api/runtime/tasks", "Rejected runtime access", { reason: access.reason });
            return NextResponse.json({ error: access.reason || "Unauthorized" }, { status: 401 });
        }

        const body = await req.json();
        if (!isRecord(body) || typeof body.action !== "string") {
            return NextResponse.json({ error: "Invalid Request: missing action" }, { status: 400 });
        }

        if (body.action === "enqueue") {
            if (!isRecord(body.task)) {
                return NextResponse.json({ error: "Invalid Request: missing task" }, { status: 400 });
            }
            const task = body.task;
            const kind = task.kind === "planned" || task.kind === "cron" ? task.kind : "adhoc";
            const scheduledAt = typeof task.scheduledAt === "number" && Number.isFinite(task.scheduledAt)
                ? Math.floor(task.scheduledAt)
                : Date.now();
            const key = typeof task.key === "string" ? task.key.trim() : undefined;
            const maxAttempts = typeof task.maxAttempts === "number" && Number.isFinite(task.maxAttempts)
                ? Math.floor(task.maxAttempts)
                : undefined;
            const context = isRecord(task.context)
                ? Object.fromEntries(Object.entries(task.context).filter(([, value]) => typeof value === "string")) as Record<string, string>
                : undefined;
            const payload = isRecord(task.payload) ? task.payload : undefined;
            const queued = await runtimeTaskSchedulerService.enqueue({
                key,
                kind,
                scheduledAt,
                maxAttempts,
                context,
                payload,
            });
            debugRouteLog(debugEnabled, "api/runtime/tasks", "Queued runtime task", {
                taskId: queued.id,
                kind: queued.kind,
                key: queued.key,
            });
            return NextResponse.json({ task: queued });
        }

        if (body.action === "cancel") {
            const taskId = typeof body.taskId === "string" ? body.taskId.trim() : "";
            if (!taskId) {
                return NextResponse.json({ error: "Invalid Request: missing taskId" }, { status: 400 });
            }
            const reason = typeof body.reason === "string" ? body.reason.trim() : undefined;
            const cancelled = await runtimeTaskSchedulerService.cancel(taskId, reason);
            if (!cancelled) {
                return NextResponse.json({ error: "Task not found." }, { status: 404 });
            }
            return NextResponse.json({ task: cancelled });
        }

        if (body.action === "repair") {
            const maxAgeMs = typeof body.maxAgeMs === "number" && Number.isFinite(body.maxAgeMs)
                ? Math.floor(body.maxAgeMs)
                : undefined;
            const repaired = await runtimeTaskSchedulerService.repairStaleRunningTasks(maxAgeMs);
            return NextResponse.json({ repaired });
        }

        return NextResponse.json({ error: `Unsupported action '${body.action}'.` }, { status: 400 });
    } catch (error: unknown) {
        debugRouteError(debugEnabled, "api/runtime/tasks", "Unhandled error in POST", error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unknown error" },
            { status: 500 },
        );
    }
}
