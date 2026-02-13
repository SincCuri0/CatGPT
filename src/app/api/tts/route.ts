import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";
import { v4 as uuidv4 } from "uuid";
import { generateEdgeTTS } from "@/lib/audio/edge-tts-handler";

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { text, voice, provider = "groq" } = body;

        if (!text) {
            return NextResponse.json({ error: "Text is required" }, { status: 400 });
        }

        if (provider === "browser") {
            return NextResponse.json({ error: "Browser provider should be handled on the client side" }, { status: 400 });
        }

        const publicAudioDir = path.join(process.cwd(), "public", "audio");
        await fs.mkdir(publicAudioDir, { recursive: true });

        const fileId = uuidv4();

        if (provider === "groq") {
            return await handleGroqTTS(text, voice || "troy", fileId, publicAudioDir);
        }
        if (provider === "edge") {
            return await handleNativeEdgeTTS(text, voice || "en-US-ChristopherNeural", fileId, publicAudioDir);
        }
        if (provider === "elevenlabs") {
            return await handleElevenLabsTTS(req, text, voice, fileId, publicAudioDir);
        }
        if (provider === "openai") {
            return NextResponse.json({ error: "OpenAI provider not yet implemented" }, { status: 501 });
        }

        return NextResponse.json({ error: `Provider ${provider} not supported on server` }, { status: 400 });
    } catch (error: unknown) {
        console.error("TTS Generation Error:", error);
        return NextResponse.json(
            { error: "Failed to generate audio", details: error instanceof Error ? error.message : "Unknown error" },
            { status: 500 }
        );
    }
}

async function handleGroqTTS(text: string, voice: string, fileId: string, audioDir: string) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
        return NextResponse.json({ error: "GROQ_API_KEY not configured" }, { status: 401 });
    }

    const GROQ_VOICES = ["autumn", "diana", "hannah", "austin", "daniel", "troy"];
    const safeVoice = GROQ_VOICES.includes(voice) ? voice : "troy";

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
        return NextResponse.json(
            { error: `Groq TTS failed: ${response.status}`, details: errText },
            { status: response.status }
        );
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    const fileName = `${fileId}.wav`;
    const outputPath = path.join(audioDir, fileName);
    await fs.writeFile(outputPath, audioBuffer);

    return NextResponse.json({ url: `/audio/${fileName}`, fileId });
}

async function handleNativeEdgeTTS(text: string, voice: string, fileId: string, audioDir: string) {
    try {
        const audioBuffer = await generateEdgeTTS(text, voice);
        const fileName = `${fileId}.mp3`;
        const outputPath = path.join(audioDir, fileName);
        await fs.writeFile(outputPath, audioBuffer);

        return NextResponse.json({ url: `/audio/${fileName}`, fileId });
    } catch (error: unknown) {
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

async function handleElevenLabsTTS(req: NextRequest, text: string, voice: string | undefined, fileId: string, audioDir: string) {
    const apiKey = resolveElevenLabsApiKey(req);
    if (!apiKey) {
        return NextResponse.json({ error: "ELEVENLABS_API_KEY not configured" }, { status: 401 });
    }

    const voiceId = typeof voice === "string" && voice.trim() ? voice.trim() : "JBFqnCBsd6RMkjVDRZzb";

    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: "POST",
        headers: {
            "xi-api-key": apiKey,
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
        },
        body: JSON.stringify({
            text,
            model_id: "eleven_turbo_v2_5",
            output_format: "mp3_44100_128",
        }),
    });

    if (!response.ok) {
        const details = await response.text();
        return NextResponse.json(
            { error: `ElevenLabs TTS failed: ${response.status}`, details },
            { status: response.status }
        );
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    const fileName = `${fileId}.mp3`;
    const outputPath = path.join(audioDir, fileName);
    await fs.writeFile(outputPath, audioBuffer);

    return NextResponse.json({ url: `/audio/${fileName}`, fileId });
}
