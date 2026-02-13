import { LLMClient } from "./types";
import { LLMProvider, ProviderConfig } from "./providerTypes";

class ProviderRegistry {
    private providers: Map<string, LLMProvider> = new Map();

    register(provider: LLMProvider) {
        this.providers.set(provider.config.id, provider);
    }

    get(id: string): LLMProvider | undefined {
        return this.providers.get(id);
    }

    getAll(): ProviderConfig[] {
        return Array.from(this.providers.values()).map(p => p.config);
    }

    createClient(providerId: string, apiKey: string, model?: string): LLMClient {
        const provider = this.get(providerId);
        if (!provider) {
            throw new Error(`Provider '${providerId}' not found`);
        }
        return provider.createClient(apiKey, model);
    }
}

import { GroqProvider } from "./providers/groq";
import { OpenAIProvider } from "./providers/openai";
import { AnthropicProvider } from "./providers/anthropic";
import { GoogleProvider } from "./providers/google";

export const providerRegistry = new ProviderRegistry();

providerRegistry.register(new GroqProvider());
providerRegistry.register(new OpenAIProvider());
providerRegistry.register(new AnthropicProvider());
providerRegistry.register(new GoogleProvider());
