import { NextRequest, NextResponse } from "next/server";
import { debugRouteError, debugRouteLog, isDebugRequest } from "@/lib/debug/server";
import { readUserSettings, updateUserSettings } from "@/lib/settings/store";
import type { UserSettingsPatch } from "@/lib/settings/schema";

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

export async function GET(req: NextRequest) {
  const debugEnabled = isDebugRequest(req);
  try {
    debugRouteLog(debugEnabled, "api/user-settings", "GET request started");
    const settings = await readUserSettings();
    debugRouteLog(debugEnabled, "api/user-settings", "Resolved user settings", settings);
    return NextResponse.json({ settings });
  } catch (error: unknown) {
    debugRouteError(debugEnabled, "api/user-settings", "Unhandled error in GET", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}

export async function PATCH(req: NextRequest) {
  const debugEnabled = isDebugRequest(req);
  try {
    debugRouteLog(debugEnabled, "api/user-settings", "PATCH request started");
    const body = await req.json();
    const patchPayload = isRecord(body) && isRecord(body.patch) ? body.patch : body;
    if (!isRecord(patchPayload)) {
      return NextResponse.json({ error: "Invalid settings payload" }, { status: 400 });
    }

    const patch = patchPayload as UserSettingsPatch;
    debugRouteLog(debugEnabled, "api/user-settings", "Applying settings patch", patch);
    const settings = await updateUserSettings(patch);
    return NextResponse.json({ settings });
  } catch (error: unknown) {
    debugRouteError(debugEnabled, "api/user-settings", "Unhandled error in PATCH", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
