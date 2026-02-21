import { NextRequest } from "next/server";
import { isDebugRequest } from "@/lib/debug/server";
import { executeMcpServicesGet } from "@/lib/runtime/kernel/mcpServices";

export async function GET(req: NextRequest) {
    const debugEnabled = isDebugRequest(req);
    return executeMcpServicesGet(req, debugEnabled);
}

