import { NextRequest } from "next/server";
import { isDebugRequest } from "@/lib/debug/server";
import { executeElevenLabsVoicesGet } from "@/lib/runtime/kernel/elevenlabsVoices";

export async function GET(req: NextRequest) {
    const debugEnabled = isDebugRequest(req);
    return executeElevenLabsVoicesGet(req, debugEnabled);
}

