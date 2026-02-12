import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/stt
 *
 * Accepts: multipart/form-data with:
 *   - file: audio blob (webm, wav, mp3, etc.)
 *   - model?: Whisper model id (default "whisper-large-v3-turbo")
 *   - language?: ISO language code (default "en")
 *
 * Returns: { text, duration? }
 *
 * Currently supports "groq" provider (Whisper on Groq).
 * To add OpenAI: same endpoint shape → https://api.openai.com/v1/audio/transcriptions
 */
export async function POST(req: NextRequest) {
    try {
        const formData = await req.formData();
        const file = formData.get("file") as File | null;
        const model = (formData.get("model") as string) || "whisper-large-v3-turbo";
        const language = (formData.get("language") as string) || "en";

        if (!file) {
            return NextResponse.json({ error: "Audio file is required" }, { status: 400 });
        }

        const apiKey = process.env.GROQ_API_KEY;
        if (!apiKey) {
            return NextResponse.json(
                { error: "GROQ_API_KEY not configured" },
                { status: 401 },
            );
        }

        // Forward to Groq's OpenAI-compatible Whisper endpoint
        const groqForm = new FormData();
        groqForm.append("file", file, file.name || "audio.webm");
        groqForm.append("model", model);
        groqForm.append("language", language);
        groqForm.append("response_format", "verbose_json");

        const response = await fetch(
            "https://api.groq.com/openai/v1/audio/transcriptions",
            {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${apiKey}`,
                },
                body: groqForm,
            },
        );

        if (!response.ok) {
            const errText = await response.text();
            console.error("Groq STT error:", errText);
            return NextResponse.json(
                { error: `Transcription failed: ${response.status}`, details: errText },
                { status: response.status },
            );
        }

        const result = await response.json();

        return NextResponse.json({
            text: result.text || "",
            duration: result.duration || null,
        });
    } catch (error: any) {
        console.error("STT Error:", error);
        return NextResponse.json(
            { error: "Failed to transcribe audio", details: error.message },
            { status: 500 },
        );
    }
}
