import { NextRequest } from "next/server";
import { isDebugRequest } from "@/lib/debug/server";
import { executeLlmModelsGet } from "@/lib/runtime/kernel/llmModels";

export async function GET(req: NextRequest) {
    const debugEnabled = isDebugRequest(req);
    return executeLlmModelsGet(req, debugEnabled);
}

