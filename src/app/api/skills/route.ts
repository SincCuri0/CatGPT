/**
 * Skills API: import, list, and attach skills to agents
 */

import { NextRequest, NextResponse } from "next/server";
import { skillsManager } from "@/lib/skills/manager";


// GET /api/skills - List all skills
export async function GET(req: NextRequest) {
  try {
    const skills = await skillsManager.listSkills();
    return NextResponse.json({ skills });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list skills" },
      { status: 500 },
    );
  }
}

// POST /api/skills - Import a new skill
export async function POST(req: NextRequest) {
  try {
    const { markdown, importedBy } = (await req.json()) as {
      markdown: string;
      importedBy?: string;
    };

    if (!markdown) {
      return NextResponse.json(
        { error: "Markdown content required" },
        { status: 400 },
      );
    }

    const skill = await skillsManager.importSkill(markdown, importedBy);

    // Emit realtime event
    // Emit realtime event
    const { runtimeStateSyncService } = await import("@/lib/runtime/services/stateSyncService");
    runtimeStateSyncService.publish(
      `skill:${skill.id}`,
      "skill.imported",
      { skill } as Record<string, unknown>
    );

    return NextResponse.json({ skill });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to import skill" },
      { status: 500 },
    );
  }
}
