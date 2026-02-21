import type { ChatGPTDetails, MappingNode, ChatGPTMessage } from "./chatgpt-types";


export interface ExtractedMessage {
    id: string; // ChatGPT Source UUID
    role: "user" | "assistant" | "system" | "tool";
    content: string; // Plain text extraction
    contentType: "text" | "code" | "execution_output" | "multimodal" | "thoughts" | "tool";
    name: string | null;
    toolName: string | null;
    toolArgs: string | null;
    isThinking: boolean;
    timestamp: number;
    modelSlug: string | null;
}

export interface ExtractedConversation {
    id: string; // ChatGPT Source UUID
    title: string;
    createTime: number;
    updateTime: number;
    messages: ExtractedMessage[];

    // Metadata for mapping
    isArchived: boolean;
    gizmoId: string | null;
    projectId: string | null;
    defaultModel: string | null;
}

/**
 * Walks the message tree from `current_node` back to root to extract the active conversation path.
 */
export function extractActivePath(conv: ChatGPTDetails): ExtractedConversation {
    const messages: ExtractedMessage[] = [];
    let currentNodeId = conv.current_node;

    while (currentNodeId) {
        const node = conv.mapping[currentNodeId];
        if (!node) break;

        const msg = node.message;
        if (msg && msg.weight !== 0) { // skip hidden/deleted messages
            const extracted = extractMessageContent(msg);
            if (extracted) {
                messages.push(extracted);
            }
        }

        currentNodeId = node.parent || ""; // walk up
    }

    // Reverse to get chronological order
    messages.reverse();

    return {
        id: conv.conversation_id,
        title: conv.title,
        createTime: conv.create_time * 1000,
        updateTime: conv.update_time * 1000,
        messages,
        isArchived: conv.is_archived || false,
        gizmoId: conv.gizmo_id || null,
        projectId: conv.conversation_template_id || null,
        defaultModel: conv.default_model_slug || null,
    };
}

function extractMessageContent(msg: ChatGPTMessage): ExtractedMessage | null {
    // Skip empty or purely structural messages
    const role = msg.author.role;
    if (role === "system" && !msg.content) return null;

    let content = "";
    let contentType: ExtractedMessage["contentType"] = "text";
    let toolName: string | null = null;
    let toolArgs: string | null = null;
    let isThinking = false;

    // Handle content types
    const c = msg.content;
    if (c.content_type === "text" && c.parts) {
        content = c.parts.join("");
    } else if (c.content_type === "code") {
        contentType = "code";
        content = c.text || "";
        // Metadata might hold language
    } else if (c.content_type === "execution_output") {
        contentType = "execution_output";
        content = c.text || "";
    } else if (c.content_type === "multimodal_text" && c.parts) {
        contentType = "multimodal";
        content = c.parts.map(part => {
            if (typeof part === "string") return part;
            if (part && typeof part === "object" && 'asset_pointer' in part) {
                return `[Image Asset: ${part.asset_pointer}]`; // Placeholder for now
            }
            return "";
        }).join("");
    } else if (c.content_type === "tether_browsing_display") {
        contentType = "tool";
        content = typeof c.result === "string" ? c.result : JSON.stringify(c.result);
    }

    // Check metadata for thinking or hidden status
    if (msg.metadata?.is_visually_hidden_from_conversation) return null;

    // Fallback if no content
    if (!content && role === "assistant") content = "(Empty message)";

    return {
        id: msg.id,
        role: role,
        content: content || "",
        contentType,
        name: msg.author.name || null,
        toolName,
        toolArgs,
        isThinking,
        timestamp: (msg.create_time || 0) * 1000,
        modelSlug: msg.metadata?.model_slug || null,
    };
}
