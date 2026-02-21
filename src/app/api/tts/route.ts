import { NextRequest } from "next/server";
import { isDebugRequest } from "@/lib/debug/server";
import { executeTtsPost } from "@/lib/runtime/kernel/tts";

export async function POST(req: NextRequest) {
    const debugEnabled = isDebugRequest(req);
    return executeTtsPost(req, debugEnabled);
}

