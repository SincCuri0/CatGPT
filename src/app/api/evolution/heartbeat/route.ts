import { NextRequest } from "next/server";
import { isDebugRequest } from "@/lib/debug/server";
import { executeEvolutionHeartbeatPost } from "@/lib/runtime/kernel/evolutionHeartbeat";

export async function POST(req: NextRequest) {
    const debugEnabled = isDebugRequest(req);
    return executeEvolutionHeartbeatPost(req, debugEnabled);
}

