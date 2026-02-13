import { NextRequest, NextResponse } from "next/server";
import { getEnvVariable, setEnvVariable, getAllApiKeys } from "@/lib/env";

export async function GET() {
    try {
        const keysConfigured = await getAllApiKeys();
        // Return which keys are configured on the server
        return NextResponse.json({
            keysConfigured,
            // We can also return the actual keys if we want the client to see them (e.g. for editing), 
            // but for security it's better to just show "Configured". 
            // However, existing logic might rely on receiving the key.
            // For now let's return the Groq key as 'apiKey' for backward compat, 
            // and a new map for all keys.
            apiKey: await getEnvVariable("GROQ_API_KEY"),
            apiKeys: {
                groq: await getEnvVariable("GROQ_API_KEY"),
                openai: await getEnvVariable("OPENAI_API_KEY"),
                anthropic: await getEnvVariable("ANTHROPIC_API_KEY"),
                google: await getEnvVariable("GEMINI_API_KEY"),
                elevenlabs: await getEnvVariable("ELEVENLABS_API_KEY"),
            }
        });
    } catch (e: unknown) {
        return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();

        // Handle legacy single key update
        if (body.apiKey) {
            await setEnvVariable("GROQ_API_KEY", body.apiKey);
        }

        // Handle multi-key update
        if (body.apiKeys) {
            const map: Record<string, string> = {
                groq: "GROQ_API_KEY",
                openai: "OPENAI_API_KEY",
                anthropic: "ANTHROPIC_API_KEY",
                google: "GEMINI_API_KEY",
                elevenlabs: "ELEVENLABS_API_KEY",
            };

            for (const [providerId, keyVal] of Object.entries(body.apiKeys)) {
                const envVar = map[providerId];
                if (envVar) {
                    await setEnvVariable(envVar, keyVal as string);
                }
            }
        }

        return NextResponse.json({ success: true });
    } catch (e: unknown) {
        return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
    }
}
