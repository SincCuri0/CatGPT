import { NextRequest } from "next/server";
import { isDebugRequest } from "@/lib/debug/server";
import { executeRuntimeTasksGet, executeRuntimeTasksPost } from "@/lib/runtime/kernel/runtimeTasks";

export async function GET(req: NextRequest) {
    const debugEnabled = isDebugRequest(req);
    return executeRuntimeTasksGet(req, debugEnabled);
}

export async function POST(req: NextRequest) {
    const debugEnabled = isDebugRequest(req);
    return executeRuntimeTasksPost(req, debugEnabled);
}
