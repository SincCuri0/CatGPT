"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { AgentConfig } from "@/lib/core/Agent";
import { getAgentPersonality } from "@/lib/agentPersonality";
import { Message } from "@/lib/core/types";
import { SquadInteractionMode } from "@/lib/core/Squad";
import { Send, Paperclip, Mic, MicOff, Volume2, VolumeX, Loader2, SkipForward, Cat, RotateCcw } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { motion, AnimatePresence } from "framer-motion";
import { useTTS, useSTT } from "@/hooks/useAudio";

interface ChatInterfaceProps {
    agent: AgentConfig;
    participantAgents?: AgentConfig[];
    interactionMode?: SquadInteractionMode;
    onSendMessage: (text: string) => Promise<void>;
    onRegenerateFromError?: (messageId: string) => Promise<void>;
    messages: Message[];
    isProcessing: boolean;
    slashCommands?: SlashCommandOption[];
    showDefaultAgentLanding?: boolean;
}

export interface SlashCommandOption {
    command: string;
    description: string;
}

function TypewriterContent({
    text,
    enabled,
    onComplete,
}: {
    text: string;
    enabled: boolean;
    onComplete?: () => void;
}) {
    const [visibleChars, setVisibleChars] = useState(() => (enabled ? 0 : text.length));
    const didCompleteRef = useRef(false);

    useEffect(() => {
        if (!enabled) {
            if (!didCompleteRef.current) {
                didCompleteRef.current = true;
                onComplete?.();
            }
            return;
        }

        if (visibleChars >= text.length && !didCompleteRef.current) {
            didCompleteRef.current = true;
            onComplete?.();
        }
    }, [enabled, onComplete, text.length, visibleChars]);

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
    interactionMode,
    onSendMessage,
    onRegenerateFromError,
    messages,
    isProcessing,
    slashCommands = [],
    showDefaultAgentLanding = false,
}: ChatInterfaceProps) {
    const [input, setInput] = useState("");
    const scrollRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [baselineMessageIds] = useState<Set<string>>(() => new Set(messages.map((msg) => msg.id)));
    const autoPlayedMessageIdsRef = useRef<Set<string>>(new Set());
    const queuedPresentationIdsRef = useRef<Set<string>>(new Set());
    const presentationQueueRef = useRef<string[]>([]);
    const queueIsRunningRef = useRef(false);
    const messagesRef = useRef<Message[]>(messages);
    const typewriterResolversRef = useRef<Map<string, () => void>>(new Map());
    const [revealedPresentationIds, setRevealedPresentationIds] = useState<Set<string>>(new Set());
    const [skippedTypewriterMessageIds, setSkippedTypewriterMessageIds] = useState<Set<string>>(new Set());
    const [activePresentationMessageId, setActivePresentationMessageId] = useState<string | null>(null);
    const [isPresentingQueue, setIsPresentingQueue] = useState(false);
    const personality = getAgentPersonality(agent);
    const agentLandingDescription = useMemo(() => {
        const explicitDescription = (agent.description || "").trim();
        if (explicitDescription) {
            return explicitDescription.replace(/^description:\s*/i, "").trim();
        }

        const prompt = (agent.systemPrompt || "").trim();
        if (!prompt) return "";

        const descriptionMatch = prompt.match(/\bdescription:\s*([\s\S]*)$/i);
        if (descriptionMatch?.[1]) {
            return descriptionMatch[1].trim();
        }

        return prompt;
    }, [agent.description, agent.systemPrompt]);
    const isLiveCampaign = interactionMode === "live_campaign";

    // Audio hooks
    const { speak, stop, isSpeaking, isLoading: ttsLoading } = useTTS();
    const { isRecording, isTranscribing, startRecording, stopRecording } = useSTT();

    // Track which message is being spoken
    const [speakingMsgId, setSpeakingMsgId] = useState<string | null>(null);
    const [activeSlashIndex, setActiveSlashIndex] = useState(0);
    const normalizedInput = input.trimStart();
    const isSlashInput = normalizedInput.startsWith("/");
    const isSlashCommandEditing = isSlashInput && /^\/\S*$/.test(normalizedInput);
    const slashCommandToken = isSlashCommandEditing ? normalizedInput.toLowerCase() : "";
    const matchingSlashCommands = isSlashCommandEditing
        ? slashCommands.filter((cmd) => {
            if (slashCommandToken === "/") return true;
            return cmd.command.toLowerCase().startsWith(slashCommandToken);
        })
        : [];
    const visibleSlashCommands = isSlashCommandEditing
        ? (matchingSlashCommands.length > 0 ? matchingSlashCommands : slashCommands)
        : [];
    const showSlashCommands = isSlashCommandEditing && visibleSlashCommands.length > 0;

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
        if (typeof msg.typewriter === "boolean") return msg.typewriter;
        return resolveStyle(msg, speaker) === "character";
    }, [baselineMessageIds, resolveStyle]);

    const shouldAutoPlay = useCallback((msg: Message, speaker: AgentConfig): boolean => {
        if (msg.role !== "assistant") return false;
        if (baselineMessageIds.has(msg.id)) return false;
        if (typeof msg.autoPlay === "boolean") return msg.autoPlay;
        return resolveStyle(msg, speaker) === "character";
    }, [baselineMessageIds, resolveStyle]);

    const resolveVoiceId = useCallback((msg: Message, speaker: AgentConfig): string => (
        msg.voiceId || speaker.voiceId || agent.voiceId || "en-US-ChristopherNeural"
    ), [agent.voiceId]);

    const shouldSequencePresentation = useCallback((msg: Message, speaker: AgentConfig): boolean => {
        if (!isLiveCampaign) return false;
        return shouldTypewriter(msg, speaker) || shouldAutoPlay(msg, speaker);
    }, [isLiveCampaign, shouldAutoPlay, shouldTypewriter]);

    const resolveTypewriterPresentation = useCallback((msgId: string) => {
        const resolve = typewriterResolversRef.current.get(msgId);
        if (!resolve) return;
        typewriterResolversRef.current.delete(msgId);
        resolve();
    }, []);

    const processPresentationQueue = useCallback(async () => {
        if (!isLiveCampaign || queueIsRunningRef.current) return;
        queueIsRunningRef.current = true;

        try {
            while (presentationQueueRef.current.length > 0) {
                const nextId = presentationQueueRef.current.shift();
                if (!nextId) continue;
                queuedPresentationIdsRef.current.delete(nextId);

                const nextMessage = messagesRef.current.find((msg) => msg.id === nextId);
                if (!nextMessage) continue;

                const speaker = resolveSpeaker(nextMessage);
                const typewriterEnabled = shouldTypewriter(nextMessage, speaker);
                const autoPlayEnabled = shouldAutoPlay(nextMessage, speaker);

                let typewriterPromise: Promise<void> = Promise.resolve();
                if (typewriterEnabled) {
                    typewriterPromise = new Promise<void>((resolve) => {
                        typewriterResolversRef.current.set(nextMessage.id, resolve);
                    });
                }

                setIsPresentingQueue(true);
                setActivePresentationMessageId(nextMessage.id);
                setRevealedPresentationIds((prev) => {
                    const next = new Set(prev);
                    next.add(nextMessage.id);
                    return next;
                });

                let speakPromise: Promise<void> = Promise.resolve();
                if (autoPlayEnabled) {
                    setSpeakingMsgId(nextMessage.id);
                    const voiceId = resolveVoiceId(nextMessage, speaker);
                    const playback = speak(nextMessage.content, voiceId);
                    playback.finally(() => {
                        setSpeakingMsgId((current) => (current === nextMessage.id ? null : current));
                    });
                    speakPromise = playback.catch(() => undefined);
                }

                await Promise.all([typewriterPromise, speakPromise]);
            }
        } finally {
            queueIsRunningRef.current = false;
            setIsPresentingQueue(false);
            setActivePresentationMessageId(null);
        }
    }, [isLiveCampaign, resolveSpeaker, resolveVoiceId, shouldAutoPlay, shouldTypewriter, speak]);

    useEffect(() => {
        messagesRef.current = messages;
    }, [messages]);

    useEffect(() => {
        if (!isLiveCampaign) {
            presentationQueueRef.current = [];
            queuedPresentationIdsRef.current.clear();
            queueIsRunningRef.current = false;
            setIsPresentingQueue(false);
            setActivePresentationMessageId(null);
            setSkippedTypewriterMessageIds(new Set());
            return;
        }

        for (const msg of messages) {
            const speaker = resolveSpeaker(msg);
            if (!shouldSequencePresentation(msg, speaker)) continue;
            if (revealedPresentationIds.has(msg.id)) continue;
            if (queuedPresentationIdsRef.current.has(msg.id)) continue;

            queuedPresentationIdsRef.current.add(msg.id);
            presentationQueueRef.current.push(msg.id);
        }

        if (presentationQueueRef.current.length > 0) {
            void processPresentationQueue();
        }
    }, [
        isLiveCampaign,
        messages,
        processPresentationQueue,
        resolveSpeaker,
        revealedPresentationIds,
        shouldSequencePresentation,
    ]);

    // Auto-scroll to bottom
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages, isProcessing, isPresentingQueue, revealedPresentationIds]);

    useEffect(() => {
        const resolvers = typewriterResolversRef.current;
        return () => {
            resolvers.forEach((resolve) => resolve());
            resolvers.clear();
            stop();
        };
    }, [stop]);

    // Auto-resize textarea
    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = "auto";
            textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
        }
    }, [input]);

    useEffect(() => {
        if (!showSlashCommands) {
            setActiveSlashIndex(0);
            return;
        }
        setActiveSlashIndex((prev) => Math.min(prev, visibleSlashCommands.length - 1));
    }, [showSlashCommands, visibleSlashCommands.length]);

    useEffect(() => {
        if (!showSlashCommands) return;
        setActiveSlashIndex(0);
    }, [showSlashCommands, slashCommandToken]);

    useEffect(() => {
        if (isLiveCampaign) return;
        const latestAssistant = [...messages].reverse().find((msg) => msg.role === "assistant");
        if (!latestAssistant) return;
        if (autoPlayedMessageIdsRef.current.has(latestAssistant.id)) return;

        const speaker = resolveSpeaker(latestAssistant);
        if (!shouldAutoPlay(latestAssistant, speaker)) return;

        autoPlayedMessageIdsRef.current.add(latestAssistant.id);
        const voiceId = resolveVoiceId(latestAssistant, speaker);
        speak(latestAssistant.content, voiceId).finally(() => setSpeakingMsgId(null));
    }, [isLiveCampaign, messages, resolveSpeaker, resolveVoiceId, shouldAutoPlay, speak]);

    const handleSkipPresentation = useCallback(() => {
        if (!isLiveCampaign) return;

        const pendingIds = new Set<string>();
        if (activePresentationMessageId) {
            pendingIds.add(activePresentationMessageId);
        }
        for (const queuedId of presentationQueueRef.current) {
            pendingIds.add(queuedId);
        }
        if (pendingIds.size === 0) return;

        presentationQueueRef.current = [];
        queuedPresentationIdsRef.current.clear();

        setSkippedTypewriterMessageIds((prev) => {
            const next = new Set(prev);
            pendingIds.forEach((id) => next.add(id));
            return next;
        });
        setRevealedPresentationIds((prev) => {
            const next = new Set(prev);
            pendingIds.forEach((id) => next.add(id));
            return next;
        });

        typewriterResolversRef.current.forEach((resolve) => resolve());
        typewriterResolversRef.current.clear();

        stop();
        setSpeakingMsgId(null);
        setIsPresentingQueue(false);
        setActivePresentationMessageId(null);
    }, [activePresentationMessageId, isLiveCampaign, stop]);

    const isInputLocked = isProcessing;

    const handleSend = (text?: string) => {
        const msg = text || input;
        if (!msg.trim() || isInputLocked) return;
        if (isPresentingQueue) {
            handleSkipPresentation();
        }
        onSendMessage(msg);
        setInput("");
        if (textareaRef.current) {
            textareaRef.current.style.height = "auto";
        }
    };

    const applySlashCommand = useCallback((command: string) => {
        setInput(`${command} `);
        requestAnimationFrame(() => {
            textareaRef.current?.focus();
        });
    }, []);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (showSlashCommands) {
            const commandCount = visibleSlashCommands.length;
            if (commandCount > 0) {
                const applyActiveSlashCommand = () => {
                    const activeCommand = visibleSlashCommands[activeSlashIndex] || visibleSlashCommands[0];
                    if (!activeCommand) return false;
                    applySlashCommand(activeCommand.command);
                    return true;
                };

                if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setActiveSlashIndex((prev) => (prev + 1) % commandCount);
                    return;
                }

                if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setActiveSlashIndex((prev) => (prev - 1 + commandCount) % commandCount);
                    return;
                }

                if (e.key === "Tab") {
                    e.preventDefault();
                    applyActiveSlashCommand();
                    return;
                }

                const caretAtEnd = e.currentTarget.selectionStart === input.length
                    && e.currentTarget.selectionEnd === input.length;
                const isApplyKey = (!e.shiftKey && e.key === "Enter")
                    || e.key === " "
                    || (e.key === "ArrowRight" && caretAtEnd);

                if (isApplyKey) {
                    e.preventDefault();
                    if (applyActiveSlashCommand()) return;
                }
            }
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
                        <div className="flex flex-col items-center justify-center min-h-[50vh] text-center gap-6 animate-in fade-in duration-500 pt-12">
                            {showDefaultAgentLanding ? (
                                <>
                                    <motion.div
                                        initial={{ scale: 0.85, opacity: 0 }}
                                        animate={{ scale: 1, opacity: 1 }}
                                        transition={{ type: "spring", stiffness: 190, damping: 15 }}
                                        className="w-24 h-24 bg-[#2f2f2f] rounded-full flex items-center justify-center shadow-2xl ring-1 ring-white/10"
                                    >
                                        <motion.div
                                            animate={{ rotate: [0, -8, 8, -4, 4, 0], y: [0, -2, 0] }}
                                            transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
                                        >
                                            <Cat size={48} className="text-[#ececec]" />
                                        </motion.div>
                                    </motion.div>

                                    <motion.div
                                        initial={{ y: 10, opacity: 0 }}
                                        animate={{ y: 0, opacity: 1 }}
                                        transition={{ delay: 0.1 }}
                                        className="space-y-2"
                                    >
                                        <h2 className="text-2xl font-semibold text-white">{agent.name}</h2>
                                        <p className="text-sm text-[#8e8ea0]">Start a chat.</p>
                                    </motion.div>
                                </>
                            ) : (
                                <>
                                    <motion.div
                                        initial={{ scale: 0.8, opacity: 0 }}
                                        animate={{ scale: 1, opacity: 1 }}
                                        transition={{ type: "spring", stiffness: 200, damping: 15 }}
                                        className="w-20 h-20 rounded-full flex items-center justify-center text-4xl shadow-lg ring-2 ring-white/10"
                                        style={{ background: personality.gradient }}
                                    >
                                        <span>{personality.emoji}</span>
                                    </motion.div>

                                    <motion.div
                                        initial={{ y: 10, opacity: 0 }}
                                        animate={{ y: 0, opacity: 1 }}
                                        transition={{ delay: 0.1 }}
                                        className="space-y-2"
                                    >
                                        <h2 className="text-2xl font-semibold text-white">{agent.name}</h2>
                                        <p className="text-sm text-[#8e8ea0]">{agent.role}</p>
                                    </motion.div>

                                    {agentLandingDescription && (
                                        <motion.p
                                            initial={{ y: 10, opacity: 0 }}
                                            animate={{ y: 0, opacity: 1 }}
                                            transition={{ delay: 0.2 }}
                                            className="text-sm text-[#b4b4b4] max-w-md leading-relaxed"
                                        >
                                            {agentLandingDescription}
                                        </motion.p>
                                    )}
                                </>
                            )}
                        </div>
                    ) : (
                        <AnimatePresence initial={false}>
                            {messages.map((msg, msgIndex) => {
                                const hasPreviousUserMessage = msgIndex > 0
                                    && messages.slice(0, msgIndex).some((candidate) => candidate.role === "user");
                                const canRegenerateError = Boolean(
                                    onRegenerateFromError
                                    && msg.role === "system"
                                    && msg.error
                                    && msgIndex === messages.length - 1
                                    && hasPreviousUserMessage,
                                );
                                const speaker = resolveSpeaker(msg);
                                const isSequencedMessage = shouldSequencePresentation(msg, speaker);
                                const isVisible = !isSequencedMessage || revealedPresentationIds.has(msg.id);
                                if (!isVisible) return null;

                                const messagePersonality = getAgentPersonality(speaker);
                                const typewriterEnabled = shouldTypewriter(msg, speaker) && !skippedTypewriterMessageIds.has(msg.id);

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
                                                    <TypewriterContent
                                                        text={msg.content}
                                                        enabled={typewriterEnabled}
                                                        onComplete={() => resolveTypewriterPresentation(msg.id)}
                                                    />
                                                </div>

                                                {isPresentingQueue && activePresentationMessageId === msg.id && (
                                                    <div className="mt-2">
                                                        <button
                                                            onClick={handleSkipPresentation}
                                                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium text-[#ececec] bg-[#2f2f2f] hover:bg-[#3a3a3a] border border-white/10 transition-colors"
                                                            title="Skip current playback and reveal queued turns"
                                                        >
                                                            <SkipForward size={12} />
                                                            Skip
                                                        </button>
                                                    </div>
                                                )}

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

                                                {canRegenerateError && (
                                                    <div className="mt-2 flex items-center gap-1">
                                                        <button
                                                            onClick={() => {
                                                                if (!onRegenerateFromError) return;
                                                                void onRegenerateFromError(msg.id);
                                                            }}
                                                            disabled={isInputLocked}
                                                            className={`p-1.5 rounded-md transition-all text-[#8e8ea0] hover:text-[#ececec] hover:bg-[#2f2f2f] ${isInputLocked ? "opacity-50 cursor-not-allowed" : ""}`}
                                                            title="Regenerate response"
                                                        >
                                                            <RotateCcw size={14} />
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
                    {(isProcessing || isPresentingQueue) && (
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
                                {visibleSlashCommands.map((cmd, index) => {
                                    const isActive = index === activeSlashIndex;
                                    return (
                                        <button
                                            key={cmd.command}
                                            type="button"
                                            onMouseEnter={() => setActiveSlashIndex(index)}
                                            onMouseDown={(e) => {
                                                e.preventDefault();
                                                setActiveSlashIndex(index);
                                                applySlashCommand(cmd.command);
                                            }}
                                            className={`w-full px-4 py-2.5 text-left transition-colors border-b border-white/5 last:border-b-0 ${
                                                isActive ? "bg-[#2f2f2f]" : "hover:bg-[#242424]"
                                            }`}
                                        >
                                            <div className="text-xs font-mono text-[#10a37f]">{cmd.command}</div>
                                            <div className="text-xs text-[#b4b4b4] mt-0.5">{cmd.description}</div>
                                        </button>
                                    );
                                })}
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
                                        isPresentingQueue ? "🔊 Playing squad turn..." :
                                        `Message ${agent.name}...`
                            }
                            rows={1}
                            className="flex-1 max-h-52 min-h-[24px] bg-transparent text-[#ececec] placeholder:text-[#b4b4b4] focus:outline-none resize-none py-3 text-[16px] leading-[24px]"
                            disabled={isInputLocked || isRecording || isTranscribing}
                        />

                        {/* Mic Button */}
                        <button
                            onClick={handleMicClick}
                            disabled={isInputLocked || isTranscribing}
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
                            disabled={!input.trim() || isInputLocked}
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
