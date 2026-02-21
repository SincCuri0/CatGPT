import { NextRequest } from "next/server";
import { isDebugRequest } from "@/lib/debug/server";
import {
    executeRuntimeObservabilityGet,
    executeRuntimeObservabilityPost,
} from "@/lib/runtime/kernel/runtimeObservability";

export async function GET(req: NextRequest) {
    const debugEnabled = isDebugRequest(req);
    return executeRuntimeObservabilityGet(req, debugEnabled);
}

export async function POST(req: NextRequest) {
    const debugEnabled = isDebugRequest(req);
    return executeRuntimeObservabilityPost(req, debugEnabled);
}
