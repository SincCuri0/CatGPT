import fs from "fs/promises";
import type { ChatGPTDetails, ExportScanResult, GPTSummary } from "./chatgpt-types";

// Helper to infer agent name from conversation titles
function inferNameFromTitles(titles: string[]): string {
    if (titles.length === 0) return "Unnamed Agent";
    // Simple heuristic: return the most common significant word, or just "Custom Agent"
    // For now, let's just use the first title + " & others" if many
    return titles[0] || "Custom Agent";
}

export async function scanChatGPTExport(filePath: string): Promise<ExportScanResult> {
    const raw = await fs.readFile(filePath, "utf-8");
    const conversations: ChatGPTDetails[] = JSON.parse(raw);

    const result: ExportScanResult = {
        totalConversations: conversations.length,
        totalMessages: 0,
        dateRange: { start: Date.now(), end: 0 },
        gpts: {},
        projects: {},
        conversations: [],
    };

    const gptTitles: Record<string, string[]> = {};

    for (const conv of conversations) {
        const msgKeys = Object.keys(conv.mapping);
        const msgCount = msgKeys.length;
        result.totalMessages += msgCount;

        const createTime = conv.create_time * 1000;
        const updateTime = conv.update_time * 1000;

        if (createTime < result.dateRange.start) result.dateRange.start = createTime;
        if (updateTime > result.dateRange.end) result.dateRange.end = updateTime;

        // Categorize
        let category: "default" | "gpt" | "project" = "default";
        let groupKey = "default";

        if (conv.conversation_template_id) {
            category = "project";
            groupKey = conv.conversation_template_id;
        } else if (conv.gizmo_id) {
            category = "gpt";
            groupKey = conv.gizmo_id;
        }

        // Initialize group stats if needed
        const targetCollection = category === "project" ? result.projects : result.gpts;
        if (!targetCollection[groupKey]) {
            targetCollection[groupKey] = {
                id: groupKey,
                name: category === "default" ? "Standard Chat" : "Unknown Agent",
                conversations: 0,
                messageCount: 0,
                lastActive: 0,
                modelDistribution: {},
            };
            gptTitles[groupKey] = [];
        }

        const summary = targetCollection[groupKey];
        summary.conversations++;
        summary.messageCount += msgCount;
        if (updateTime > summary.lastActive) summary.lastActive = updateTime;

        // Track titles for name inference
        if (conv.title && gptTitles[groupKey].length < 5) {
            gptTitles[groupKey].push(conv.title);
        }

        // Add to discovery list
        result.conversations.push({
            id: conv.conversation_id,
            title: conv.title || "Untitled Chat",
            create_time: createTime,
            update_time: updateTime,
            message_count: msgCount,
            is_archived: conv.is_archived || false,
            category,
            gizmo_id: conv.gizmo_id || undefined,
            conversation_template_id: conv.conversation_template_id || undefined,
        });
    }

    // Post-process names
    for (const key of Object.keys(result.gpts)) {
        if (key !== "default" && result.gpts[key].name === "Unknown Agent") {
            const titles = gptTitles[key];
            if (titles.length > 0) {
                result.gpts[key].name = `GPT (${titles[0].slice(0, 20)}...)`;
            }
        }
    }
    for (const key of Object.keys(result.projects)) {
        if (result.projects[key].name === "Unknown Agent") {
            const titles = gptTitles[key];
            if (titles.length > 0) {
                result.projects[key].name = `Project (${titles[0].slice(0, 20)}...)`;
            } else {
                result.projects[key].name = "Unnamed Project";
            }
        }
    }

    return result;
}
