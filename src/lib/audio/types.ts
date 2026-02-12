/**
 * Provider-agnostic audio types.
 *
 * Adding a new provider (e.g. ElevenLabs, OpenAI, Google) is a two-step process:
 *   1. Add its id to TTSProvider / STTProvider.
 *   2. Handle it in the api/tts and api/stt route handlers.
 *
 * The UI and hooks never need to change — they just read AudioSettings.
 */

// ── TTS ──────────────────────────────────────────────

export type TTSProvider = "groq" | "edge" | "browser" | "openai" | "elevenlabs";

export interface TTSVoice {
    id: string;
    label: string;
    gender: "male" | "female" | "neutral";
    provider: TTSProvider;
}

/** Groq Orpheus voices */
export const GROQ_TTS_VOICES: TTSVoice[] = [
    { id: "troy", label: "Troy", gender: "male", provider: "groq" },
    { id: "austin", label: "Austin", gender: "male", provider: "groq" },
    { id: "daniel", label: "Daniel", gender: "male", provider: "groq" },
    { id: "autumn", label: "Autumn", gender: "female", provider: "groq" },
    { id: "diana", label: "Diana", gender: "female", provider: "groq" },
    { id: "hannah", label: "Hannah", gender: "female", provider: "groq" },
];

/** Microsoft Edge TTS voices (free, no API key) */
export const EDGE_TTS_VOICES: TTSVoice[] = [
    { id: "en-US-ChristopherNeural", label: "Christopher", gender: "male", provider: "edge" },
    { id: "en-US-GuyNeural", label: "Guy", gender: "male", provider: "edge" },
    { id: "en-US-AndrewNeural", label: "Andrew", gender: "male", provider: "edge" },
    { id: "en-US-AnaNeural", label: "Ana", gender: "female", provider: "edge" },
    { id: "en-US-JennyNeural", label: "Jenny", gender: "female", provider: "edge" },
    { id: "en-GB-SoniaNeural", label: "Sonia", gender: "female", provider: "edge" },
    { id: "en-US-AvaNeural", label: "Ava", gender: "female", provider: "edge" },
];

/** Browser Native voices (provided by OS/Browser) */
export const BROWSER_TTS_VOICES: TTSVoice[] = [
    { id: "native-1", label: "System Default", gender: "neutral", provider: "browser" },
];

// ── STT ──────────────────────────────────────────────

export type STTProvider = "groq" | "browser" | "openai";

export const GROQ_STT_MODELS = [
    { id: "whisper-large-v3-turbo", label: "Whisper V3 Turbo", desc: "Fast & accurate" },
    { id: "whisper-large-v3", label: "Whisper V3", desc: "Most accurate" },
] as const;

// ── Settings ─────────────────────────────────────────

export interface AudioSettings {
    ttsEnabled: boolean;
    ttsProvider: TTSProvider;
    ttsVoice: string;           // voice id within the chosen provider
    ttsAutoPlay: boolean;       // auto-play assistant messages

    sttEnabled: boolean;
    sttProvider: STTProvider;
    sttModel: string;           // model id within the chosen provider
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
    ttsEnabled: true,
    ttsProvider: "groq",
    ttsVoice: "troy",
    ttsAutoPlay: false,

    sttEnabled: true,
    sttProvider: "groq",
    sttModel: "whisper-large-v3-turbo",
};

export function loadAudioSettings(): AudioSettings {
    if (typeof window === "undefined") return DEFAULT_AUDIO_SETTINGS;
    try {
        const stored = localStorage.getItem("audio_settings");
        if (stored) return { ...DEFAULT_AUDIO_SETTINGS, ...JSON.parse(stored) };
    } catch { /* ignore */ }
    return DEFAULT_AUDIO_SETTINGS;
}

export function saveAudioSettings(settings: AudioSettings) {
    if (typeof window === "undefined") return;
    localStorage.setItem("audio_settings", JSON.stringify(settings));
}
