import { NextRequest } from "next/server";
import { isDebugRequest } from "@/lib/debug/server";
import { executeRuntimeStateGet } from "@/lib/runtime/kernel/runtimeState";

export async function GET(req: NextRequest) {
    const debugEnabled = isDebugRequest(req);
    return executeRuntimeStateGet(req, debugEnabled);
}
