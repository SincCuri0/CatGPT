import { NextRequest } from "next/server";
import { isDebugRequest } from "@/lib/debug/server";
import { executeEvolutionRunPost } from "@/lib/runtime/kernel/evolutionRun";

export async function POST(req: NextRequest) {
    const debugEnabled = isDebugRequest(req);
    return executeEvolutionRunPost(req, debugEnabled);
}

