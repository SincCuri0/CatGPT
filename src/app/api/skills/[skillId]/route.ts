/**
 * Skills detail API: get, delete, search skills
 */

import { NextRequest, NextResponse } from "next/server";
import { skillsManager } from "@/lib/skills/manager";


interface RouteParams {
  params: {
    skillId: string;
  };
}

// GET /api/skills/:skillId - Get a specific skill
export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const { skillId } = params;

    // Handle search query
    const searchQuery = req.nextUrl.searchParams.get("search");
    if (searchQuery) {
      const results = await skillsManager.searchSkills(searchQuery);
      return NextResponse.json({ skills: results });
    }

    const skill = await skillsManager.getSkill(skillId);
    if (!skill) {
      return NextResponse.json({ error: "Skill not found" }, { status: 404 });
    }

    return NextResponse.json({ skill });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to get skill" },
      { status: 500 },
    );
  }
}

// DELETE /api/skills/:skillId - Delete a skill
export async function DELETE(req: NextRequest, { params }: RouteParams) {
  try {
    const { skillId } = params;

    const deleted = await skillsManager.deleteSkill(skillId);
    if (!deleted) {
      return NextResponse.json({ error: "Skill not found" }, { status: 404 });
    }

    // Emit realtime event
    // Emit realtime event
    const { runtimeStateSyncService } = await import("@/lib/runtime/services/stateSyncService");
    runtimeStateSyncService.publish(
      `skill:${skillId}`,
      "skill.updated",
      { skillId, action: "deleted" } as Record<string, unknown>
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete skill" },
      { status: 500 },
    );
  }
}
