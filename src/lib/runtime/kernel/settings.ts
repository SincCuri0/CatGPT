import { NextRequest, NextResponse } from "next/server";
import { setEnvVariable, getAllApiKeys } from "@/lib/env";
import { debugRouteError, debugRouteLog } from "@/lib/debug/server";
import { isRecord } from "@/lib/runtime/kernel/validation";

const PROVIDER_ENV_KEY_MAP: Record<string, string> = {
    groq: "GROQ_API_KEY",
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    google: "GEMINI_API_KEY",
    elevenlabs: "ELEVENLABS_API_KEY",
};

export async function executeSettingsGet(req: NextRequest, debugEnabled: boolean): Promise<Response> {
    try {
        debugRouteLog(debugEnabled, "api/settings", "GET request started");
        const keysConfigured = await getAllApiKeys();
        debugRouteLog(debugEnabled, "api/settings", "Resolved key configuration state", keysConfigured);
        return NextResponse.json({ keysConfigured });
    } catch (error: unknown) {
        debugRouteError(debugEnabled, "api/settings", "Unhandled error in GET", error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unknown error" },
            { status: 500 },
        );
    }
}

export async function executeSettingsPost(req: NextRequest, debugEnabled: boolean): Promise<Response> {
    try {
        debugRouteLog(debugEnabled, "api/settings", "POST request started");
        const body = await req.json() as unknown;
        if (!isRecord(body)) {
            return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
        }

        const apiKeysRaw = isRecord(body.apiKeys) ? body.apiKeys : {};
        debugRouteLog(debugEnabled, "api/settings", "Received settings payload", {
            providers: Object.keys(apiKeysRaw),
        });

        for (const [providerId, keyValue] of Object.entries(apiKeysRaw)) {
            const envVar = PROVIDER_ENV_KEY_MAP[providerId];
            if (!envVar) continue;
            if (typeof keyValue === "string") {
                await setEnvVariable(envVar, keyValue);
            }
        }

        debugRouteLog(debugEnabled, "api/settings", "Settings update completed");
        return NextResponse.json({ success: true });
    } catch (error: unknown) {
        debugRouteError(debugEnabled, "api/settings", "Unhandled error in POST", error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Unknown error" },
            { status: 500 },
        );
    }
}

