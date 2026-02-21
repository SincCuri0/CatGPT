import { NextRequest } from "next/server";
import { isDebugRequest } from "@/lib/debug/server";
import { executeAgentsCreateCatsPost } from "@/lib/runtime/kernel/agentsCreateCats";

export async function POST(req: NextRequest) {
    const debugEnabled = isDebugRequest(req);
    return executeAgentsCreateCatsPost(req, debugEnabled);
}

