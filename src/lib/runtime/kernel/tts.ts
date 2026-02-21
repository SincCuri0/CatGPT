import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";
import { createHash } from "crypto";
import { ElevenLabsClient, ElevenLabsError } from "@elevenlabs/elevenlabs-js";
import { generateEdgeTTS } from "@/lib/audio/edge-tts-handler";
import { debugRouteError, debugRouteLog } from "@/lib/debug/server";

export async function executeTtsPost(req: NextRequest, debugEnabled: boolean): Promise<Response> {
    try {
        debugRouteLog(debugEnabled, "api/tts", "POST request started");
        const body = await req.json();
        const { text, voice, provider = "groq" } = body;
        debugRouteLog(debugEnabled, "api/tts", "Parsed TTS payload", {
            provider,
            hasVoiceOverride: Boolean(voice),
            textLength: typeof text === "string" ? text.trim().length : 0,
        });

        if (typeof text !== "string" || !text.trim()) {
            debugRouteLog(debugEnabled, "api/tts", "Rejected request: text missing");
            return NextResponse.json({ error: "Text is required" }, { status: 400 });
        }

        if (provider === "browser") {
            debugRouteLog(debugEnabled, "api/tts", "Rejected request: browser provider should run client-side");
            return NextResponse.json({ error: "Browser provider should be handled on the client side" }, { status: 400 });
        }

        const publicAudioDir = path.join(process.cwd(), "public", "audio");
        await fs.mkdir(publicAudioDir, { recursive: true });
        const normalizedText = text.trim();

        if (provider === "groq") {
            return await handleGroqTTS(normalizedText, voice || "troy", publicAudioDir, debugEnabled);
        }
        if (provider === "edge") {
            return await handleNativeEdgeTTS(normalizedText, voice || "en-US-ChristopherNeural", publicAudioDir, debugEnabled);
        }
        if (provider === "elevenlabs") {
            return await handleElevenLabsTTS(req, normalizedText, voice, publicAudioDir, debugEnabled);
        }
        if (provider === "openai") {
            debugRouteLog(debugEnabled, "api/tts", "OpenAI provider requested but not implemented");
            return NextResponse.json({ error: "OpenAI provider not yet implemented" }, { status: 501 });
        }

        debugRouteLog(debugEnabled, "api/tts", "Unsupported provider requested", { provider });
        return NextResponse.json({ error: `Provider ${provider} not supported on server` }, { status: 400 });
    } catch (error: unknown) {
        debugRouteError(debugEnabled, "api/tts", "Unhandled error in POST", error);
        console.error("TTS Generation Error:", error);
        return NextResponse.json(
            { error: "Failed to generate audio", details: error instanceof Error ? error.message : "Unknown error" },
            { status: 500 },
        );
    }
}

function buildAudioCacheId(provider: string, voice: string, text: string): string {
    return createHash("sha256")
        .update("tts-v1")
        .update("\u0000")
        .update(provider)
        .update("\u0000")
        .update(voice)
        .update("\u0000")
        .update(text)
        .digest("hex")
        .slice(0, 32);
}

async function hasUsableAudioFile(filePath: string): Promise<boolean> {
    try {
        const stats = await fs.stat(filePath);
        return stats.isFile() && stats.size > 0;
    } catch {
        return false;
    }
}

async function handleGroqTTS(text: string, voice: string, audioDir: string, debugEnabled: boolean): Promise<Response> {
    const GROQ_VOICES = ["autumn", "diana", "hannah", "austin", "daniel", "troy"];
    const safeVoice = GROQ_VOICES.includes(voice) ? voice : "troy";
    const fileId = buildAudioCacheId("groq", safeVoice, text);
    const fileName = `${fileId}.wav`;
    const outputPath = path.join(audioDir, fileName);

    if (await hasUsableAudioFile(outputPath)) {
        debugRouteLog(debugEnabled, "api/tts", "Groq cache hit", { fileName });
        return NextResponse.json({ url: `/audio/${fileName}`, fileId, cached: true });
    }
    debugRouteLog(debugEnabled, "api/tts", "Groq cache miss", { voice: safeVoice, fileName });

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
        return NextResponse.json({ error: "GROQ_API_KEY not configured" }, { status: 401 });
    }

    const response = await fetch("https://api.groq.com/openai/v1/audio/speech", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: "canopylabs/orpheus-v1-english",
            input: text,
            voice: safeVoice,
            response_format: "wav",
        }),
    });

    if (!response.ok) {
        const errText = await response.text();
        debugRouteLog(debugEnabled, "api/tts", "Groq TTS failed", { status: response.status });
        return NextResponse.json(
            { error: `Groq TTS failed: ${response.status}`, details: errText },
            { status: response.status },
        );
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(outputPath, audioBuffer);
    debugRouteLog(debugEnabled, "api/tts", "Groq audio generated", { bytes: audioBuffer.byteLength, fileName });

    return NextResponse.json({ url: `/audio/${fileName}`, fileId, cached: false });
}

async function handleNativeEdgeTTS(text: string, voice: string, audioDir: string, debugEnabled: boolean): Promise<Response> {
    const safeVoice = typeof voice === "string" && voice.trim() ? voice.trim() : "en-US-ChristopherNeural";
    const fileId = buildAudioCacheId("edge", safeVoice, text);
    const fileName = `${fileId}.mp3`;
    const outputPath = path.join(audioDir, fileName);

    if (await hasUsableAudioFile(outputPath)) {
        debugRouteLog(debugEnabled, "api/tts", "Edge cache hit", { fileName });
        return NextResponse.json({ url: `/audio/${fileName}`, fileId, cached: true });
    }
    debugRouteLog(debugEnabled, "api/tts", "Edge cache miss", { voice: safeVoice, fileName });

    try {
        const audioBuffer = await generateEdgeTTS(text, safeVoice);
        await fs.writeFile(outputPath, audioBuffer);
        debugRouteLog(debugEnabled, "api/tts", "Edge audio generated", { bytes: audioBuffer.byteLength, fileName });

        return NextResponse.json({ url: `/audio/${fileName}`, fileId, cached: false });
    } catch (error: unknown) {
        debugRouteError(debugEnabled, "api/tts", "Edge TTS handler error", error, { voice: safeVoice });
        console.error("Edge TTS Handler Error:", error);
        return NextResponse.json({ error: "Edge TTS failed", details: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
    }
}

function resolveElevenLabsApiKey(req: NextRequest): string | null {
    const fromHeader = req.headers.get("x-elevenlabs-api-key");
    if (fromHeader && fromHeader.trim()) return fromHeader.trim();

    const rawApiKeys = req.headers.get("x-api-keys");
    if (rawApiKeys) {
        try {
            const parsed = JSON.parse(rawApiKeys) as Record<string, string>;
            const key = parsed.elevenlabs;
            if (typeof key === "string" && key.trim()) return key.trim();
        } catch {
            // ignore malformed local keys
        }
    }

    return process.env.ELEVENLABS_API_KEY || null;
}

async function handleElevenLabsTTS(
    req: NextRequest,
    text: string,
    voice: string | undefined,
    audioDir: string,
    debugEnabled: boolean,
): Promise<Response> {
    const voiceId = typeof voice === "string" && voice.trim() ? voice.trim() : "JBFqnCBsd6RMkjVDRZzb";
    const fileId = buildAudioCacheId("elevenlabs", voiceId, text);
    const fileName = `${fileId}.mp3`;
    const outputPath = path.join(audioDir, fileName);

    if (await hasUsableAudioFile(outputPath)) {
        debugRouteLog(debugEnabled, "api/tts", "ElevenLabs cache hit", { fileName });
        return NextResponse.json({ url: `/audio/${fileName}`, fileId, cached: true });
    }
    debugRouteLog(debugEnabled, "api/tts", "ElevenLabs cache miss", { voiceId, fileName });

    const apiKey = resolveElevenLabsApiKey(req);
    if (!apiKey) {
        return NextResponse.json({ error: "ELEVENLABS_API_KEY not configured" }, { status: 401 });
    }

    try {
        const elevenlabs = new ElevenLabsClient({ apiKey });
        const audioStream = await elevenlabs.textToSpeech.convert(voiceId, {
            text,
            modelId: "eleven_turbo_v2_5",
            outputFormat: "mp3_44100_128",
        });
        const audioBuffer = Buffer.from(await new Response(audioStream).arrayBuffer());
        await fs.writeFile(outputPath, audioBuffer);
        debugRouteLog(debugEnabled, "api/tts", "ElevenLabs audio generated", { bytes: audioBuffer.byteLength, fileName });

        return NextResponse.json({ url: `/audio/${fileName}`, fileId, cached: false });
    } catch (error: unknown) {
        if (error instanceof ElevenLabsError) {
            const status = error.statusCode || 500;
            const details = formatErrorDetails(error.body);
            debugRouteLog(debugEnabled, "api/tts", "ElevenLabs TTS failed", { status, details });
            return NextResponse.json(
                { error: `ElevenLabs TTS failed: ${status}`, details },
                { status },
            );
        }
        debugRouteError(debugEnabled, "api/tts", "Unexpected ElevenLabs error", error);
        throw error;
    }
}

function formatErrorDetails(details: unknown): string {
    if (typeof details === "string") return details;
    if (details == null) return "";
    try {
        return JSON.stringify(details);
    } catch {
        return String(details);
    }
}

