"use client";

import { useState, useRef, useCallback } from "react";
import { loadAudioSettings } from "@/lib/audio/types";

// ── TTS ──────────────────────────────────────────────

export function useTTS() {
    const [isSpeaking, setIsSpeaking] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const synthRef = useRef<SpeechSynthesis | null>(null);

    const speak = useCallback(async (text: string, voiceOverride?: string) => {
        const settings = loadAudioSettings();
        if (!settings.ttsEnabled) return;

        // Strip markdown for cleaner speech
        const cleanText = text
            .replace(/```[\s\S]*?```/g, " (code block) ")
            .replace(/`([^`]+)`/g, "$1")
            .replace(/[*_~#>\[\]()!]/g, "")
            .replace(/\n+/g, " ")
            .trim();

        if (!cleanText) return;

        // Stop any existing playback (Audio and Synthesis)
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current = null;
        }
        if (window.speechSynthesis) {
            window.speechSynthesis.cancel();
        }

        if (settings.ttsProvider === "browser") {
            setIsSpeaking(true);
            const utterance = new SpeechSynthesisUtterance(cleanText);
            utterance.onend = () => setIsSpeaking(false);
            utterance.onerror = () => setIsSpeaking(false);
            window.speechSynthesis.speak(utterance);
            return;
        }

        // Cloud Providers (Groq, OpenAI, etc.)
        const truncated = cleanText.length > 2000 ? cleanText.substring(0, 2000) + "..." : cleanText;
        setIsLoading(true);

        try {
            const response = await fetch("/api/tts", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    text: truncated,
                    voice: voiceOverride || settings.ttsVoice,
                    provider: settings.ttsProvider,
                }),
            });

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.error || "TTS failed");
            }

            const data = await response.json();
            const audio = new Audio(data.url);
            audioRef.current = audio;

            audio.onplay = () => setIsSpeaking(true);
            audio.onended = () => { setIsSpeaking(false); audioRef.current = null; };
            audio.onerror = () => { setIsSpeaking(false); audioRef.current = null; };

            await audio.play();
        } catch (err) {
            console.error("TTS Error:", err);
            // Fallback to browser if API fails
            const utterance = new SpeechSynthesisUtterance(cleanText);
            utterance.onend = () => setIsSpeaking(false);
            window.speechSynthesis.speak(utterance);
        } finally {
            setIsLoading(false);
        }
    }, []);

    const stop = useCallback(() => {
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current.currentTime = 0;
            audioRef.current = null;
        }
        if (window.speechSynthesis) {
            window.speechSynthesis.cancel();
        }
        setIsSpeaking(false);
    }, []);

    return { speak, stop, isSpeaking, isLoading };
}

// ── STT ──────────────────────────────────────────────

export function useSTT() {
    const [isRecording, setIsRecording] = useState(false);
    const [isTranscribing, setIsTranscribing] = useState(false);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);

    const startRecording = useCallback(async (): Promise<void> => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

            // Prefer webm (Chrome/Edge), fall back to mp4 (Safari)
            const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
                ? "audio/webm;codecs=opus"
                : "audio/mp4";

            const recorder = new MediaRecorder(stream, { mimeType });
            mediaRecorderRef.current = recorder;
            chunksRef.current = [];

            recorder.ondataavailable = (e) => {
                if (e.data.size > 0) chunksRef.current.push(e.data);
            };

            recorder.start(250); // collect chunks every 250ms
            setIsRecording(true);
        } catch (err) {
            console.error("Mic access error:", err);
            throw err;
        }
    }, []);

    const stopRecording = useCallback(async (): Promise<string> => {
        return new Promise((resolve, reject) => {
            const recorder = mediaRecorderRef.current;
            if (!recorder || recorder.state === "inactive") {
                reject(new Error("Not recording"));
                return;
            }

            recorder.onstop = async () => {
                setIsRecording(false);
                setIsTranscribing(true);

                try {
                    const settings = loadAudioSettings();
                    const blob = new Blob(chunksRef.current, { type: recorder.mimeType });

                    // Stop all mic tracks
                    recorder.stream.getTracks().forEach((t) => t.stop());

                    if (settings.sttProvider === "browser") {
                        // Use Web Speech API fallback (no API call needed)
                        const text = await browserSTT();
                        resolve(text);
                    } else {
                        // Send to our STT API route (Groq Whisper)
                        const formData = new FormData();
                        const ext = recorder.mimeType.includes("webm") ? "webm" : "mp4";
                        formData.append("file", blob, `recording.${ext}`);
                        formData.append("model", settings.sttModel);

                        const response = await fetch("/api/stt", {
                            method: "POST",
                            body: formData,
                        });

                        if (!response.ok) {
                            const err = await response.json();
                            throw new Error(err.error || "Transcription failed");
                        }

                        const data = await response.json();
                        resolve(data.text || "");
                    }
                } catch (err) {
                    console.error("STT Error:", err);
                    reject(err);
                } finally {
                    setIsTranscribing(false);
                }
            };

            recorder.stop();
        });
    }, []);

    const cancelRecording = useCallback(() => {
        const recorder = mediaRecorderRef.current;
        if (recorder && recorder.state !== "inactive") {
            recorder.stream.getTracks().forEach((t) => t.stop());
            recorder.stop();
        }
        setIsRecording(false);
        setIsTranscribing(false);
        chunksRef.current = [];
    }, []);

    return {
        isRecording,
        isTranscribing,
        startRecording,
        stopRecording,
        cancelRecording,
    };
}

// ── Browser STT Fallback (Web Speech API) ────────────

function browserSTT(): Promise<string> {
    return new Promise((resolve, reject) => {
        const SpeechRecognition =
            (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

        if (!SpeechRecognition) {
            reject(new Error("Web Speech API not supported in this browser"));
            return;
        }

        const recognition = new SpeechRecognition();
        recognition.lang = "en-US";
        recognition.interimResults = false;
        recognition.maxAlternatives = 1;

        recognition.onresult = (event: any) => {
            resolve(event.results[0][0].transcript);
        };

        recognition.onerror = (event: any) => {
            reject(new Error(`Speech recognition error: ${event.error}`));
        };

        recognition.start();
    });
}
