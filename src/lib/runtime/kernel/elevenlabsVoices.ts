import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { debugRouteError, debugRouteLog } from "@/lib/debug/server";

const CACHE_DIR = path.join(process.cwd(), ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "elevenlabs-voices.json");
const CACHE_TTL_MS = 1000 * 60 * 60 * 6;

interface CachedVoices {
    updatedAt: number;
    voices: Array<{ id: string; label: string; gender: "male" | "female" | "neutral"; provider: "elevenlabs" }>;
}

async function readCache(): Promise<CachedVoices | null> {
    try {
        const raw = await fs.readFile(CACHE_FILE, "utf8");
        const parsed = JSON.parse(raw) as CachedVoices;
        if (!Array.isArray(parsed.voices)) return null;
        return parsed;
    } catch {
        return null;
    }
}

async function writeCache(payload: CachedVoices) {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(payload, null, 2), "utf8");
}

export async function executeElevenLabsVoicesGet(req: NextRequest, debugEnabled: boolean): Promise<Response> {
    try {
        const forceRefresh = req.nextUrl.searchParams.get("refresh") === "1";
        const cache = await readCache();
        const isFresh = cache ? (Date.now() - cache.updatedAt) < CACHE_TTL_MS : false;
        debugRouteLog(debugEnabled, "api/elevenlabs/voices", "GET request started", {
            forceRefresh,
            cachePresent: Boolean(cache),
            cacheFresh: isFresh,
        });

        if (cache && isFresh && !forceRefresh) {
            debugRouteLog(debugEnabled, "api/elevenlabs/voices", "Serving fresh voices cache", {
                voiceCount: cache.voices.length,
            });
            return NextResponse.json({ voices: cache.voices, cached: true, updatedAt: cache.updatedAt });
        }

        const apiKey = process.env.ELEVENLABS_API_KEY;
        if (!apiKey) {
            debugRouteLog(debugEnabled, "api/elevenlabs/voices", "API key missing; serving cache fallback when available");
            if (cache) {
                return NextResponse.json({ voices: cache.voices, cached: true, stale: true, updatedAt: cache.updatedAt });
            }
            return NextResponse.json({ error: "ELEVENLABS_API_KEY not configured", voices: [] }, { status: 401 });
        }

        const response = await fetch("https://api.elevenlabs.io/v2/voices", {
            headers: {
                "xi-api-key": apiKey,
                Accept: "application/json",
            },
        });

        if (!response.ok) {
            const details = await response.text();
            debugRouteLog(debugEnabled, "api/elevenlabs/voices", "Provider call failed", { status: response.status });
            if (cache) {
                return NextResponse.json({ voices: cache.voices, cached: true, stale: true, details }, { status: 200 });
            }
            return NextResponse.json({ error: `Failed to fetch voices (${response.status})`, details }, { status: response.status });
        }

        const data: { voices?: Array<{ voice_id?: string; name?: string; labels?: { gender?: string } }> } = await response.json();
        const voices = (Array.isArray(data.voices) ? data.voices : [])
            .map((voice) => ({
                id: String(voice.voice_id || "").trim(),
                label: String(voice.name || "Unnamed voice").trim(),
                gender: (
                    voice?.labels?.gender === "male" || voice?.labels?.gender === "female"
                        ? voice.labels.gender
                        : "neutral"
                ) as "male" | "female" | "neutral",
                provider: "elevenlabs" as const,
            }))
            .filter((voice: { id: string }) => voice.id.length > 0);

        const payload: CachedVoices = { updatedAt: Date.now(), voices };
        await writeCache(payload);
        debugRouteLog(debugEnabled, "api/elevenlabs/voices", "Fetched and cached voices", {
            voiceCount: voices.length,
            updatedAt: payload.updatedAt,
        });

        return NextResponse.json({ voices, cached: false, updatedAt: payload.updatedAt });
    } catch (error: unknown) {
        debugRouteError(debugEnabled, "api/elevenlabs/voices", "Unhandled error in GET", error);
        return NextResponse.json(
            { error: "Failed to load ElevenLabs voices", details: error instanceof Error ? error.message : "Unknown error" },
            { status: 500 },
        );
    }
}

