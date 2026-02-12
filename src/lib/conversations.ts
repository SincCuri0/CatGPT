import { Message } from "./core/types";

export interface Conversation {
    id: string;
    agentId: string;
    title: string;
    messages: Message[];
    createdAt: number;
    updatedAt: number;
}

const STORAGE_KEY = "cat_gpt_conversations";

/**
 * Load all conversations from localStorage.
 */
export function loadConversations(): Conversation[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

/**
 * Save all conversations to localStorage.
 */
export function saveConversations(conversations: Conversation[]): void {
    if (typeof window === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
}

/**
 * Get conversations for a specific agent, sorted by most recent first.
 */
export function getConversationsForAgent(agentId: string): Conversation[] {
    return loadConversations()
        .filter(c => c.agentId === agentId)
        .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Get a single conversation by ID.
 */
export function getConversation(id: string): Conversation | undefined {
    return loadConversations().find(c => c.id === id);
}

/**
 * Create or update a conversation in storage.
 */
export function upsertConversation(conversation: Conversation): void {
    const all = loadConversations();
    const idx = all.findIndex(c => c.id === conversation.id);
    if (idx >= 0) {
        all[idx] = conversation;
    } else {
        all.push(conversation);
    }
    saveConversations(all);
}

/**
 * Delete a conversation from storage.
 */
export function deleteConversation(id: string): void {
    const all = loadConversations().filter(c => c.id !== id);
    saveConversations(all);
}

/**
 * Rename a conversation.
 */
export function renameConversation(id: string, newTitle: string): void {
    const all = loadConversations();
    const conv = all.find(c => c.id === id);
    if (conv) {
        conv.title = newTitle;
        conv.updatedAt = Date.now();
        saveConversations(all);
    }
}

/**
 * Generate a short title from the first user message.
 */
export function generateTitle(message: string): string {
    const cleaned = message.trim().replace(/\n/g, " ");
    if (cleaned.length <= 40) return cleaned;
    // Cut at word boundary
    const truncated = cleaned.substring(0, 40);
    const lastSpace = truncated.lastIndexOf(" ");
    return (lastSpace > 20 ? truncated.substring(0, lastSpace) : truncated) + "…";
}
