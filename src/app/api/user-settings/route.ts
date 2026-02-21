import { NextRequest } from "next/server";
import { isDebugRequest } from "@/lib/debug/server";
import { executeUserSettingsGet, executeUserSettingsPatch } from "@/lib/runtime/kernel/userSettings";

export async function GET(req: NextRequest) {
    const debugEnabled = isDebugRequest(req);
    return executeUserSettingsGet(req, debugEnabled);
}

export async function PATCH(req: NextRequest) {
    const debugEnabled = isDebugRequest(req);
    return executeUserSettingsPatch(req, debugEnabled);
}

