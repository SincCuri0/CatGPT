/**
 * Scheduler detail API: update, delete, view runs
 */

import { NextRequest, NextResponse } from "next/server";
import { schedulerManager } from "@/lib/scheduler/manager";


interface RouteParams {
  params: {
    scheduleId: string;
  };
}

// GET /api/scheduler/schedules/:scheduleId - Get schedule or its runs
export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const { scheduleId } = params;
    const viewRuns = req.nextUrl.searchParams.get("runs") === "true";

    if (viewRuns) {
      const runs = await schedulerManager.getRunsForSchedule(scheduleId);
      return NextResponse.json({ runs });
    }

    const schedule = await schedulerManager.getSchedule(scheduleId);
    if (!schedule) {
      return NextResponse.json({ error: "Schedule not found" }, { status: 404 });
    }

    return NextResponse.json({ schedule });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to get schedule",
      },
      { status: 500 },
    );
  }
}

// PUT /api/scheduler/schedules/:scheduleId - Update a schedule
export async function PUT(req: NextRequest, { params }: RouteParams) {
  try {
    const { scheduleId } = params;
    const body = await req.json();

    const updated = await schedulerManager.updateSchedule(scheduleId, body);
    if (!updated) {
      return NextResponse.json({ error: "Schedule not found" }, { status: 404 });
    }

    // Emit realtime event
    // Emit realtime event
    const { runtimeStateSyncService } = await import("@/lib/runtime/services/stateSyncService");
    runtimeStateSyncService.publish(
      `schedule:${scheduleId}`,
      "schedule.created",
      { schedule: updated, action: "updated" } as Record<string, unknown>
    );

    return NextResponse.json({ schedule: updated });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to update schedule",
      },
      { status: 500 },
    );
  }
}

// DELETE /api/scheduler/schedules/:scheduleId - Delete a schedule
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  try {
    const { scheduleId } = params;

    const deleted = await schedulerManager.deleteSchedule(scheduleId);
    if (!deleted) {
      return NextResponse.json({ error: "Schedule not found" }, { status: 404 });
    }

    // Emit realtime event
    // Emit realtime event
    const { runtimeStateSyncService } = await import("@/lib/runtime/services/stateSyncService");
    runtimeStateSyncService.publish(
      `schedule:${scheduleId}`,
      "schedule.created",
      { scheduleId, action: "deleted" } as Record<string, unknown>
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to delete schedule",
      },
      { status: 500 },
    );
  }
}
