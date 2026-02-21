import { NextRequest, NextResponse } from "next/server";
import { debugRouteError, debugRouteLog } from "@/lib/debug/server";

export async function executeSttPost(req: NextRequest, debugEnabled: boolean): Promise<Response> {
    try {
        debugRouteLog(debugEnabled, "api/stt", "POST request started");
        const formData = await req.formData();
        const file = formData.get("file") as File | null;
        const model = (formData.get("model") as string) || "whisper-large-v3-turbo";
        const language = (formData.get("language") as string) || "en";
        debugRouteLog(debugEnabled, "api/stt", "Parsed STT request", {
            hasFile: Boolean(file),
            model,
            language,
            fileSize: file?.size ?? 0,
        });

        if (!file) {
            debugRouteLog(debugEnabled, "api/stt", "Rejected request: no audio file");
            return NextResponse.json({ error: "Audio file is required" }, { status: 400 });
        }

        const apiKey = process.env.GROQ_API_KEY;
        if (!apiKey) {
            return NextResponse.json(
                { error: "GROQ_API_KEY not configured" },
                { status: 401 },
            );
        }

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
            debugRouteLog(debugEnabled, "api/stt", "Groq transcription failed", { status: response.status });
            console.error("Groq STT error:", errText);
            return NextResponse.json(
                { error: `Transcription failed: ${response.status}`, details: errText },
                { status: response.status },
            );
        }

        const result = await response.json();
        debugRouteLog(debugEnabled, "api/stt", "Transcription completed", {
            duration: result.duration || null,
            textLength: typeof result.text === "string" ? result.text.length : 0,
        });

        return NextResponse.json({
            text: result.text || "",
            duration: result.duration || null,
        });
    } catch (error: unknown) {
        debugRouteError(debugEnabled, "api/stt", "Unhandled error in POST", error);
        console.error("STT Error:", error);
        const details = error instanceof Error ? error.message : "Unknown error";
        return NextResponse.json(
            { error: "Failed to transcribe audio", details },
            { status: 500 },
        );
    }
}

