import type { ReasoningEffort } from "./types";

export interface Model {
    id: string;
    label: string;
    description?: string;
}

export interface ProviderInfo {
    id: string;
    name: string;
    description: string;
    defaultModel: string;
    models: Model[];
    requiresApiKey: boolean;
    apiKeyLink?: string;
}

export interface ReasoningEffortOption {
    id: ReasoningEffort;
    label: string;
    description: string;
}

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

export const REASONING_EFFORT_OPTIONS: ReasoningEffortOption[] = [
    { id: "none", label: "Off", description: "Favor fastest response with no extra reasoning budget." },
    { id: "low", label: "Low", description: "Use a small reasoning budget for simple tasks." },
    { id: "medium", label: "Medium", description: "Balanced depth and speed for most prompts." },
    { id: "high", label: "High", description: "Use deeper reasoning for complex prompts." },
];

export const PROVIDERS: ProviderInfo[] = [
    {
        id: "groq",
        name: "Groq",
        description: "Fastest inference",
        defaultModel: "llama-3.3-70b-versatile",
        models: [
            { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", description: "Best quality" },
            { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B", description: "Fast & light" },
            { id: "gemma2-9b-it", label: "Gemma 2 9B", description: "Google model on Groq" },
        ],
        requiresApiKey: true,
        apiKeyLink: "https://console.groq.com/keys",
    },
    {
        id: "openai",
        name: "OpenAI",
        description: "Creators of GPT-4",
        defaultModel: "gpt-4o",
        models: [
            { id: "gpt-4o", label: "GPT-4o", description: "Most capable model" },
            { id: "gpt-4-turbo", label: "GPT-4 Turbo", description: "Fast & accurate" },
            { id: "gpt-3.5-turbo", label: "GPT-3.5 Turbo", description: "Fast & cheap" },
        ],
        requiresApiKey: true,
        apiKeyLink: "https://platform.openai.com/api-keys",
    },
    {
        id: "anthropic",
        name: "Anthropic",
        description: "Creators of Claude",
        defaultModel: "claude-3-opus-20240229",
        models: [
            { id: "claude-3-opus-20240229", label: "Claude 3 Opus", description: "Most powerful" },
            { id: "claude-3-sonnet-20240229", label: "Claude 3 Sonnet", description: "Balanced" },
            { id: "claude-3-haiku-20240307", label: "Claude 3 Haiku", description: "Fastest" },
        ],
        requiresApiKey: true,
        apiKeyLink: "https://console.anthropic.com/settings/keys",
    },
    {
        id: "google",
        name: "Google Gemini",
        description: "Multimodal models from Google",
        defaultModel: "gemini-1.5-pro",
        models: [
            { id: "gemini-1.5-pro", label: "Gemini 1.5 Pro", description: "Mid-size multimodal" },
            { id: "gemini-1.5-flash", label: "Gemini 1.5 Flash", description: "Fast & cost-efficient" },
            { id: "gemini-pro", label: "Gemini 1.0 Pro", description: "Legacy Pro" },
        ],
        requiresApiKey: true,
        apiKeyLink: "https://aistudio.google.com/app/apikey",
    },
];
