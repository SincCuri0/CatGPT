import { NextRequest } from "next/server";
import { isDebugRequest } from "@/lib/debug/server";
import { executeEvolutionStatusPost } from "@/lib/runtime/kernel/evolutionStatus";

export async function POST(req: NextRequest) {
    const debugEnabled = isDebugRequest(req);
    return executeEvolutionStatusPost(req, debugEnabled);
}

