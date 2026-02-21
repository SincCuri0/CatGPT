import { NextRequest } from "next/server";
import { isDebugRequest } from "@/lib/debug/server";
import { executeAgentsGenerateInstructionsPost } from "@/lib/runtime/kernel/agentsGenerateInstructions";

export async function POST(req: NextRequest) {
    const debugEnabled = isDebugRequest(req);
    return executeAgentsGenerateInstructionsPost(req, debugEnabled);
}

