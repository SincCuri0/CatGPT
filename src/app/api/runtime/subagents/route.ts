import { NextRequest } from "next/server";
import { isDebugRequest } from "@/lib/debug/server";
import { executeRuntimeSubagentsGet, executeRuntimeSubagentsPost } from "@/lib/runtime/kernel/runtimeSubagents";

export async function GET(req: NextRequest) {
    const debugEnabled = isDebugRequest(req);
    return executeRuntimeSubagentsGet(req, debugEnabled);
}

export async function POST(req: NextRequest) {
    const debugEnabled = isDebugRequest(req);
    return executeRuntimeSubagentsPost(req, debugEnabled);
}

