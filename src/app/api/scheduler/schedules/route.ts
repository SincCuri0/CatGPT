/**
 * Scheduler API: manage agent schedules
 */

import { NextRequest, NextResponse } from "next/server";
import { schedulerManager } from "@/lib/scheduler/manager";


// GET /api/scheduler/schedules - List schedules
export async function GET(req: NextRequest) {
  try {
    const agentId = req.nextUrl.searchParams.get("agentId");
    const scheduleId = req.nextUrl.searchParams.get("scheduleId");

    if (scheduleId) {
      const schedule = await schedulerManager.getSchedule(scheduleId);
      return NextResponse.json({ schedule });
    }

    if (agentId) {
      const schedules = await schedulerManager.listSchedulesForAgent(agentId);
      return NextResponse.json({ schedules });
    }

    return NextResponse.json({ error: "agentId required" }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to list schedules",
      },
      { status: 500 },
    );
  }
}

// POST /api/scheduler/schedules - Create a new schedule
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const schedule = await schedulerManager.createSchedule({
      agentId: body.agentId,
      name: body.name,
      description: body.description,
      type: body.type || "cron",
      cronExpression: body.cronExpression,
      runAt: body.runAt,
      enabled: body.enabled !== false,
      maxDurationMs: body.maxDurationMs,
      maxRetries: body.maxRetries,
    });

    // Emit realtime event
    // Emit realtime event
    const { runtimeStateSyncService } = await import("@/lib/runtime/services/stateSyncService");
    runtimeStateSyncService.publish(
      `schedule:${schedule.id}`,
      "schedule.created",
      { schedule } as Record<string, unknown>
    );

    return NextResponse.json({ schedule });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to create schedule",
      },
      { status: 500 },
    );
  }
}
