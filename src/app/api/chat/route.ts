import { NextRequest } from "next/server";
import { isDebugRequest } from "@/lib/debug/server";
import { executeChatPost } from "@/lib/runtime/kernel/chat";

export async function POST(req: NextRequest) {
    const debugEnabled = isDebugRequest(req);
    return executeChatPost(req, debugEnabled);
}

