import { NextRequest } from "next/server";
import { isDebugRequest } from "@/lib/debug/server";
import { executeSettingsGet, executeSettingsPost } from "@/lib/runtime/kernel/settings";

export async function GET(req: NextRequest) {
    const debugEnabled = isDebugRequest(req);
    return executeSettingsGet(req, debugEnabled);
}

export async function POST(req: NextRequest) {
    const debugEnabled = isDebugRequest(req);
    return executeSettingsPost(req, debugEnabled);
}

