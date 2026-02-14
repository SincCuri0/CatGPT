import { NextRequest, NextResponse } from "next/server";
import { subAgentCoordinator } from "@/lib/core/runtime/SubAgentCoordinator";
import { clampTimeoutMs } from "@/lib/core/runtime/config";
import { debugRouteError, debugRouteLog, isDebugRequest } from "@/lib/debug/server";
import { authorizeRuntimeAccess } from "@/lib/security/runtimeAccess";

function toPositiveInt(value: string | null | undefined): number | undefined {
    if (!value) return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        return undefined;
    }
    return parsed;
}

export async function GET(req: NextRequest) {
    const debugEnabled = isDebugRequest(req);
    try {
        const access = authorizeRuntimeAccess(req);
        if (!access.ok) {
            debugRouteLog(debugEnabled, "api/runtime/subagents", "Rejected runtime access", { reason: access.reason });
            return NextResponse.json({ error: access.reason || "Unauthorized" }, { status: 401 });
        }

        const runId = req.nextUrl.searchParams.get("runId")?.trim() || "";
        const parentRunId = req.nextUrl.searchParams.get("parentRunId")?.trim() || "";
        const limit = toPositiveInt(req.nextUrl.searchParams.get("limit"));
        const waitMs = toPositiveInt(req.nextUrl.searchParams.get("waitMs"));

        debugRouteLog(debugEnabled, "api/runtime/subagents", "GET request started", {
            hasRunId: Boolean(runId),
            hasParentRunId: Boolean(parentRunId),
            limit,
            waitMs,
        });

        if (runId) {
            const run = waitMs
                ? await subAgentCoordinator.awaitRun(runId, clampTimeoutMs(waitMs))
                : await subAgentCoordinator.getRun(runId);

            if (!run) {
                return NextResponse.json({ error: `Run '${runId}' not found.` }, { status: 404 });
            }

            if (parentRunId && run.parentRunId !== parentRunId) {
                return NextResponse.json(
                    { error: `Run '${runId}' is not scoped to parentRunId '${parentRunId}'.` },
                    { status: 403 },
                );
            }

            return NextResponse.json({ run });
        }

        if (!parentRunId) {
            return NextResponse.json(
                { error: "Provide either runId or parentRunId." },
                { status: 400 },
            );
        }

        const [runs, metrics] = await Promise.all([
            subAgentCoordinator.listRuns(parentRunId, limit),
            subAgentCoordinator.getMetrics(),
        ]);

        return NextResponse.json({
            parentRunId,
            runs,
            metrics,
        });
    } catch (error: unknown) {
        debugRouteError(debugEnabled, "api/runtime/subagents", "Unhandled error in GET", error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unknown error" },
            { status: 500 },
        );
    }
}

export async function POST(req: NextRequest) {
    const debugEnabled = isDebugRequest(req);
    try {
        const access = authorizeRuntimeAccess(req);
        if (!access.ok) {
            debugRouteLog(debugEnabled, "api/runtime/subagents", "Rejected runtime access", { reason: access.reason });
            return NextResponse.json({ error: access.reason || "Unauthorized" }, { status: 401 });
        }

        const body = await req.json();
        const action = typeof body?.action === "string" ? body.action.trim().toLowerCase() : "";
        const runId = typeof body?.runId === "string" ? body.runId.trim() : "";
        const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
        const parentRunId = typeof body?.parentRunId === "string" ? body.parentRunId.trim() : "";

        if (action !== "cancel") {
            return NextResponse.json({ error: "Unsupported action. Use action='cancel'." }, { status: 400 });
        }
        if (!runId) {
            return NextResponse.json({ error: "runId is required for cancel action." }, { status: 400 });
        }

        const run = await subAgentCoordinator.getRun(runId);
        if (!run) {
            return NextResponse.json({ error: `Run '${runId}' not found.` }, { status: 404 });
        }
        if (parentRunId && run.parentRunId !== parentRunId) {
            return NextResponse.json(
                { error: `Run '${runId}' is not scoped to parentRunId '${parentRunId}'.` },
                { status: 403 },
            );
        }

        const cancelled = await subAgentCoordinator.cancelRun(
            runId,
            reason || "Sub-agent run cancelled via runtime ops API.",
        );
        if (!cancelled) {
            return NextResponse.json({ error: `Run '${runId}' could not be cancelled.` }, { status: 409 });
        }

        return NextResponse.json({ run: cancelled });
    } catch (error: unknown) {
        debugRouteError(debugEnabled, "api/runtime/subagents", "Unhandled error in POST", error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unknown error" },
            { status: 500 },
        );
    }
}
