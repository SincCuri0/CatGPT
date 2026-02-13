"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { AgentConfig } from "@/lib/core/Agent";
import { getAgentPersonality } from "@/lib/agentPersonality";
import { Message } from "@/lib/core/types";
import { Send, Paperclip, Mic, MicOff, Volume2, VolumeX, Loader2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { motion, AnimatePresence } from "framer-motion";
import { useTTS, useSTT } from "@/hooks/useAudio";

interface ChatInterfaceProps {
    agent: AgentConfig;
    participantAgents?: AgentConfig[];
    onSendMessage: (text: string) => Promise<void>;
    messages: Message[];
    isProcessing: boolean;
    slashCommands?: SlashCommandOption[];
}

export interface SlashCommandOption {
    command: string;
    description: string;
}

function TypewriterContent({ text, enabled }: { text: string; enabled: boolean }) {
    const [visibleChars, setVisibleChars] = useState(() => (enabled ? 0 : text.length));

    useEffect(() => {
        if (!enabled || visibleChars >= text.length) {
            return;
        }

        const step = text.length > 1800 ? 12 : text.length > 900 ? 8 : text.length > 450 ? 5 : 3;
        const intervalId = window.setInterval(() => {
            setVisibleChars((prev) => {
                const next = Math.min(text.length, prev + step);
                if (next >= text.length) {
                    window.clearInterval(intervalId);
                }
                return next;
            });
        }, 16);

        return () => window.clearInterval(intervalId);
    }, [enabled, text.length, visibleChars]);

    if (enabled && visibleChars < text.length) {
        return <div className="whitespace-pre-wrap">{text.slice(0, visibleChars)}</div>;
    }

    return <ReactMarkdown>{text}</ReactMarkdown>;
}

export function ChatInterface({
    agent,
    participantAgents = [],
    onSendMessage,
    messages,
    isProcessing,
    slashCommands = [],
}: ChatInterfaceProps) {
    const [input, setInput] = useState("");
    const scrollRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [baselineMessageIds] = useState<Set<string>>(() => new Set(messages.map((msg) => msg.id)));
    const autoPlayedMessageIdsRef = useRef<Set<string>>(new Set());
    const personality = getAgentPersonality(agent);

    // Audio hooks
    const { speak, stop, isSpeaking, isLoading: ttsLoading } = useTTS();
    const { isRecording, isTranscribing, startRecording, stopRecording } = useSTT();

    // Track which message is being spoken
    const [speakingMsgId, setSpeakingMsgId] = useState<string | null>(null);
    const normalizedInput = input.trimStart();
    const isSlashInput = normalizedInput.startsWith("/");
    const slashCommandToken = isSlashInput ? normalizedInput.split(/\s+/)[0].toLowerCase() : "";
    const matchingSlashCommands = isSlashInput
        ? slashCommands.filter((cmd) => {
            if (slashCommandToken === "/") return true;
            return cmd.command.toLowerCase().startsWith(slashCommandToken);
        })
        : [];
    const visibleSlashCommands = isSlashInput
        ? (matchingSlashCommands.length > 0 ? matchingSlashCommands : slashCommands)
        : [];
    const showSlashCommands = visibleSlashCommands.length > 0;

    const allParticipants = useMemo(() => {
        const byId = new Map<string, AgentConfig>();
        const entries = [agent, ...participantAgents];
        for (const item of entries) {
            if (item.id) {
                byId.set(item.id, item);
            }
        }
        return Array.from(byId.values());
    }, [agent, participantAgents]);

    const participantsById = useMemo(() => {
        const map = new Map<string, AgentConfig>();
        for (const participant of allParticipants) {
            if (participant.id) map.set(participant.id, participant);
        }
        return map;
    }, [allParticipants]);

    const participantsByName = useMemo(() => {
        const map = new Map<string, AgentConfig>();
        for (const participant of allParticipants) {
            const name = participant.name?.trim().toLowerCase();
            if (name) map.set(name, participant);
        }
        return map;
    }, [allParticipants]);

    const resolveSpeaker = useCallback((msg: Message): AgentConfig => {
        if (msg.agentId && participantsById.has(msg.agentId)) {
            return participantsById.get(msg.agentId)!;
        }
        const normalizedName = msg.name?.trim().toLowerCase();
        if (normalizedName && participantsByName.has(normalizedName)) {
            return participantsByName.get(normalizedName)!;
        }
        return agent;
    }, [agent, participantsById, participantsByName]);

    const resolveStyle = useCallback((msg: Message, speaker: AgentConfig): string => (
        msg.agentStyle || speaker.style || "assistant"
    ), []);

    const shouldTypewriter = useCallback((msg: Message, speaker: AgentConfig): boolean => {
        if (msg.role !== "assistant") return false;
        if (baselineMessageIds.has(msg.id)) return false;
        if (msg.typewriter) return true;
        return resolveStyle(msg, speaker) === "character";
    }, [baselineMessageIds, resolveStyle]);

    const shouldAutoPlay = useCallback((msg: Message, speaker: AgentConfig): boolean => {
        if (msg.role !== "assistant") return false;
        if (baselineMessageIds.has(msg.id)) return false;
        if (msg.autoPlay) return true;
        return resolveStyle(msg, speaker) === "character";
    }, [baselineMessageIds, resolveStyle]);

    const resolveVoiceId = useCallback((msg: Message, speaker: AgentConfig): string => (
        msg.voiceId || speaker.voiceId || agent.voiceId || "en-US-ChristopherNeural"
    ), [agent.voiceId]);

    // Auto-scroll to bottom
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages, isProcessing]);

    // Auto-resize textarea
    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = "auto";
            textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
        }
    }, [input]);

    useEffect(() => {
        const latestAssistant = [...messages].reverse().find((msg) => msg.role === "assistant");
        if (!latestAssistant) return;
        if (autoPlayedMessageIdsRef.current.has(latestAssistant.id)) return;

        const speaker = resolveSpeaker(latestAssistant);
        if (!shouldAutoPlay(latestAssistant, speaker)) return;

        autoPlayedMessageIdsRef.current.add(latestAssistant.id);
        const voiceId = resolveVoiceId(latestAssistant, speaker);
        speak(latestAssistant.content, voiceId).finally(() => setSpeakingMsgId(null));
    }, [messages, resolveSpeaker, resolveVoiceId, shouldAutoPlay, speak]);

    const handleSend = (text?: string) => {
        const msg = text || input;
        if (!msg.trim() || isProcessing) return;
        onSendMessage(msg);
        setInput("");
        if (textareaRef.current) {
            textareaRef.current.style.height = "auto";
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Tab" && showSlashCommands) {
            e.preventDefault();
            setInput(`${visibleSlashCommands[0].command} `);
            return;
        }

        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    // ── Voice Input ──────────────────────────────────

    const handleMicClick = async () => {
        if (isRecording) {
            try {
                const transcript = await stopRecording();
                if (transcript.trim()) {
                    setInput((prev) => (prev ? prev + " " + transcript : transcript));
                }
            } catch (err) {
                console.error("Recording error:", err);
            }
        } else {
            try {
                await startRecording();
            } catch {
                // Mic permission denied — silently fail
            }
        }
    };

    // ── TTS Playback ─────────────────────────────────

    const handleSpeak = (msg: Message) => {
        const speaker = resolveSpeaker(msg);
        const voiceId = resolveVoiceId(msg, speaker);

        if (isSpeaking && speakingMsgId === msg.id) {
            stop();
            setSpeakingMsgId(null);
        } else {
            setSpeakingMsgId(msg.id);
            speak(msg.content, voiceId).finally(() => setSpeakingMsgId(null));
        }
    };

    return (
        <div className="flex flex-col h-full bg-[#212121] text-[#ececec] font-sans relative">

            {/* Messages Area */}
            <div className="flex-1 overflow-y-auto w-full custom-scrollbar scroll-smooth" ref={scrollRef}>
                <div className="w-full max-w-3xl mx-auto py-8 px-4 flex flex-col gap-6">
                    {messages.length === 0 ? (
                        /* Agent Identity Landing Page */
                        <div className="flex flex-col items-center justify-center min-h-[50vh] text-center gap-6 animate-in fade-in duration-500 pt-12">
                            {/* Agent Avatar */}
                            <motion.div
                                initial={{ scale: 0.8, opacity: 0 }}
                                animate={{ scale: 1, opacity: 1 }}
                                transition={{ type: "spring", stiffness: 200, damping: 15 }}
                                className="w-20 h-20 rounded-full flex items-center justify-center text-4xl shadow-lg ring-2 ring-white/10"
                                style={{ background: personality.gradient }}
                            >
                                <span>{personality.emoji}</span>
                            </motion.div>

                            {/* Agent Name & Role */}
                            <motion.div
                                initial={{ y: 10, opacity: 0 }}
                                animate={{ y: 0, opacity: 1 }}
                                transition={{ delay: 0.1 }}
                                className="space-y-2"
                            >
                                <h2 className="text-2xl font-semibold text-white">{agent.name}</h2>
                                <p className="text-sm text-[#8e8ea0]">{agent.role}</p>
                            </motion.div>

                            {/* System Prompt Preview */}
                            {agent.systemPrompt && (
                                <motion.p
                                    initial={{ y: 10, opacity: 0 }}
                                    animate={{ y: 0, opacity: 1 }}
                                    transition={{ delay: 0.2 }}
                                    className="text-sm text-[#b4b4b4] max-w-md leading-relaxed"
                                >
                                    {agent.systemPrompt.length > 120
                                        ? agent.systemPrompt.substring(0, 120) + "..."
                                        : agent.systemPrompt}
                                </motion.p>
                            )}
                        </div>
                    ) : (
                        <AnimatePresence initial={false}>
                            {messages.map((msg) => {
                                const speaker = resolveSpeaker(msg);
                                const messagePersonality = getAgentPersonality(speaker);
                                const typewriterEnabled = shouldTypewriter(msg, speaker);

                                return (
                                    <motion.div
                                        initial={{ opacity: 0, y: 10 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        key={msg.id}
                                        className={`flex w-full ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                                    >
                                        <div className={`flex gap-4 max-w-[85%] md:max-w-[75%] ${msg.role === "user" ? "flex-row-reverse" : "flex-row text-left"}`}>

                                            {/* Avatar (Only for Assistant/System) */}
                                            {msg.role !== "user" && (
                                                <div
                                                    className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-1 shadow-sm text-base"
                                                    style={{ background: messagePersonality.gradient }}
                                                >
                                                    <span>{messagePersonality.emoji}</span>
                                                </div>
                                            )}

                                            {/* Content Bubble */}
                                            <div className={`text-[15px] leading-relaxed selection:bg-[#10a37f]/30 ${
                                                msg.role === "user"
                                                    ? "bg-[#2f2f2f] text-white px-5 py-3 rounded-3xl rounded-tr-sm shadow-sm"
                                                    : "text-[#ececec] py-1 px-1"
                                            }`}
                                            >
                                                {msg.role !== "user" && msg.name && (
                                                    <div className="text-[11px] uppercase tracking-wide text-[#8e8ea0] mb-1.5 font-semibold">
                                                        {msg.name}
                                                    </div>
                                                )}

                                                <div className="prose prose-invert prose-p:leading-7 prose-pre:bg-black/50 prose-pre:border prose-pre:border-white/10 prose-pre:p-4 prose-pre:rounded-lg max-w-none break-words [&_p]:!my-0 [&_*:first-child]:!mt-0 [&_*:last-child]:!mb-0">
                                                    <TypewriterContent text={msg.content} enabled={typewriterEnabled} />
                                                </div>

                                                {/* TTS Button (assistant messages only) */}
                                                {msg.role === "assistant" && (
                                                    <div className="mt-2 flex items-center gap-1">
                                                        <button
                                                            onClick={() => handleSpeak(msg)}
                                                            className={`p-1.5 rounded-md transition-all text-[#8e8ea0] hover:text-[#ececec] hover:bg-[#2f2f2f] ${
                                                                isSpeaking && speakingMsgId === msg.id ? "text-[#10a37f] bg-[#10a37f]/10" : ""
                                                            }`}
                                                            title={isSpeaking && speakingMsgId === msg.id ? "Stop speaking" : "Read aloud"}
                                                        >
                                                            {ttsLoading && speakingMsgId === msg.id ? (
                                                                <Loader2 size={14} className="animate-spin" />
                                                            ) : isSpeaking && speakingMsgId === msg.id ? (
                                                                <VolumeX size={14} />
                                                            ) : (
                                                                <Volume2 size={14} />
                                                            )}
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </motion.div>
                                );
                            })}
                        </AnimatePresence>
                    )}

                    {/* Typing Indicator */}
                    {isProcessing && (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            className="flex justify-start w-full"
                        >
                            <div className="flex gap-4 max-w-[85%]">
                                <div
                                    className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-1 text-base"
                                    style={{ background: personality.gradient }}
                                >
                                    <span>{personality.emoji}</span>
                                </div>
                                <div className="flex items-center gap-1.5 py-3 px-1">
                                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                                </div>
                            </div>
                        </motion.div>
                    )}
                </div>
            </div>

            {/* Input Area */}
            <div className="w-full px-4 pt-2 pb-6 z-20 bg-[#212121]">
                <div className="max-w-3xl mx-auto w-full relative">
                    {showSlashCommands && (
                        <div className="absolute left-0 right-0 bottom-full mb-2 z-30">
                            <div className="bg-[#171717] border border-white/10 rounded-xl shadow-xl overflow-hidden">
                                {visibleSlashCommands.map((cmd) => (
                                    <button
                                        key={cmd.command}
                                        type="button"
                                        onMouseDown={(e) => {
                                            e.preventDefault();
                                            setInput(`${cmd.command} `);
                                            textareaRef.current?.focus();
                                        }}
                                        className="w-full px-4 py-2.5 text-left hover:bg-[#2f2f2f] transition-colors border-b border-white/5 last:border-b-0"
                                    >
                                        <div className="text-xs font-mono text-[#10a37f]">{cmd.command}</div>
                                        <div className="text-xs text-[#b4b4b4] mt-0.5">{cmd.description}</div>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                    <div className="relative flex items-end w-full p-3 bg-[#2f2f2f] rounded-[26px] border border-white/5 focus-within:border-white/20 transition-colors shadow-lg overflow-hidden ring-1 ring-black/5">

                        {/* Attach Button */}
                        <button className="p-2 mr-2 text-[#ececec] hover:bg-[#424242] rounded-full transition-colors self-end mb-1">
                            <Paperclip size={20} />
                        </button>

                        <textarea
                            ref={textareaRef}
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder={
                                isRecording ? "🎙️ Listening..." :
                                    isTranscribing ? "⏳ Transcribing..." :
                                        `Message ${agent.name}...`
                            }
                            rows={1}
                            className="flex-1 max-h-52 min-h-[24px] bg-transparent text-[#ececec] placeholder:text-[#b4b4b4] focus:outline-none resize-none py-3 text-[16px] leading-[24px]"
                            disabled={isProcessing || isRecording || isTranscribing}
                        />

                        {/* Mic Button */}
                        <button
                            onClick={handleMicClick}
                            disabled={isProcessing || isTranscribing}
                            className={`p-2 ml-1 rounded-full transition-all duration-200 self-end mb-1 ${
                                isRecording
                                    ? "bg-red-500/20 text-red-400 animate-pulse hover:bg-red-500/30"
                                    : isTranscribing
                                        ? "text-[#10a37f] cursor-wait"
                                        : "text-[#b4b4b4] hover:text-[#ececec] hover:bg-[#424242]"
                            }`}
                            title={isRecording ? "Stop recording" : "Voice input"}
                        >
                            {isTranscribing ? (
                                <Loader2 size={20} className="animate-spin" />
                            ) : isRecording ? (
                                <MicOff size={20} />
                            ) : (
                                <Mic size={20} />
                            )}
                        </button>

                        {/* Send Button */}
                        <button
                            onClick={() => handleSend()}
                            disabled={!input.trim() || isProcessing}
                            className={`p-2 ml-1 rounded-full transition-all duration-200 self-end mb-1 ${
                                input.trim()
                                    ? "bg-[#ececec] text-black hover:bg-white"
                                    : "bg-[#676767] text-[#2f2f2f] cursor-not-allowed opacity-50"
                            }`}
                        >
                            <Send size={18} strokeWidth={2.5} />
                        </button>
                    </div>
                    <div className="text-center mt-2">
                        <span className="text-xs text-[#b4b4b4] opacity-70">
                            CatGPT can make mistakes. Check important info.
                        </span>
                    </div>
                </div>
            </div>
        </div>
    );
}
