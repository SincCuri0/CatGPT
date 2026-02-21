import { NextRequest } from "next/server";
import { isDebugRequest } from "@/lib/debug/server";
import { executeSttPost } from "@/lib/runtime/kernel/stt";

export async function POST(req: NextRequest) {
    const debugEnabled = isDebugRequest(req);
    return executeSttPost(req, debugEnabled);
}

