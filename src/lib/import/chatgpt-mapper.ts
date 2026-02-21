import { prisma } from "../db";
import type { ChatGPTDetails, ExportScanResult } from "./chatgpt-types";
import { extractActivePath } from "./chatgpt-extractor";

interface ImportOptions {
    userId: string;
    importRecordId: string;
    scanResult: ExportScanResult;
}

export async function importChatGPTConversations(
    conversations: ChatGPTDetails[],
    options: ImportOptions
) {
    const { userId, importRecordId, scanResult } = options;

    // Cache for created agents/squads to minimize DB lookups
    const agentCache = new Map<string, string>(); // sourceGizmoId -> dbId
    const squadCache = new Map<string, string>(); // sourceGizmoId -> dbId

    let importedCount = 0;

    // Process in batches to manage transaction size
    const BATCH_SIZE = 50;
    for (let i = 0; i < conversations.length; i += BATCH_SIZE) {
        const batch = conversations.slice(i, i + BATCH_SIZE);

        // Execute batch sequentially
        for (const rawConv of batch) {
            try {
                const extracted = extractActivePath(rawConv);

                // 1. Resolve Agent (if Custom GPT)
                let agentId: string | null = null;
                if (extracted.gizmoId) {
                    if (agentCache.has(extracted.gizmoId)) {
                        agentId = agentCache.get(extracted.gizmoId)!;
                    } else {
                        // Find or create agent
                        const existingAgent = await prisma.agent.findFirst({
                            where: { sourceGizmoId: extracted.gizmoId, userId },
                            select: { id: true }
                        });

                        if (existingAgent) {
                            agentId = existingAgent.id;
                        } else {
                            // Create new agent with inferred name
                            const info = scanResult.gpts[extracted.gizmoId];
                            const name = info ? info.name : "Imported Agent";

                            const newAgent = await prisma.agent.create({
                                data: {
                                    name,
                                    role: "Custom GPT imported from ChatGPT",
                                    systemPrompt: "This agent was imported from a ChatGPT export. Original system prompt not available.",
                                    source: "chatgpt_import",
                                    sourceGizmoId: extracted.gizmoId,
                                    userId,
                                    tools: "[]"
                                },
                                select: { id: true }
                            });
                            agentId = newAgent.id;
                        }
                        agentCache.set(extracted.gizmoId, agentId);
                    }
                }

                // 2. Resolve Squad (if Project)
                let squadId: string | null = null;
                if (extracted.projectId) {
                    if (squadCache.has(extracted.projectId)) {
                        squadId = squadCache.get(extracted.projectId)!;
                    } else {
                        // Find or create squad
                        const existingSquad = await prisma.squad.findFirst({
                            where: { sourceGizmoId: extracted.projectId }, // Squads might be shared? limiting to user for now? No, user is import owner
                            select: { id: true }
                        });

                        if (existingSquad) {
                            squadId = existingSquad.id;
                        } else {
                            // Create new squad
                            const info = scanResult.projects[extracted.projectId];
                            const name = info ? info.name : "Imported Project";

                            const newSquad = await prisma.squad.create({
                                data: {
                                    name,
                                    source: "chatgpt_import",
                                    sourceGizmoId: extracted.projectId,
                                    // Add user as owner
                                    members: {
                                        create: {
                                            userId,
                                            role: "owner"
                                        }
                                    }
                                },
                                select: { id: true }
                            });
                            squadId = newSquad.id;
                        }
                        squadCache.set(extracted.projectId, squadId);
                    }
                }

                // 3. Upsert Conversation
                // We use sourceId to prevent duplicates on re-import
                const conversation = await prisma.conversation.upsert({
                    where: { sourceId: extracted.id },
                    update: {
                        title: extracted.title,
                        isArchived: extracted.isArchived,
                        updatedAt: new Date(extracted.updateTime),
                        // Don't overwrite existing agent/squad associations if user changed them
                    },
                    create: {
                        title: extracted.title,
                        sourceId: extracted.id,
                        source: "chatgpt_import",
                        userId,
                        agentId,
                        squadId,
                        isArchived: extracted.isArchived,
                        createdAt: new Date(extracted.createTime),
                        updatedAt: new Date(extracted.updateTime),
                        importRecordId,
                        tags: "[]"
                    }
                });

                // 4. Replace Messages
                // Delete existing messages for this conversation (to handle re-imports cleanly)
                await prisma.message.deleteMany({
                    where: { conversationId: conversation.id }
                });

                // Create new messages
                if (extracted.messages.length > 0) {
                    await prisma.message.createMany({
                        data: extracted.messages.map((msg, index) => ({
                            conversationId: conversation.id,
                            role: msg.role,
                            content: msg.content,
                            contentType: msg.contentType,
                            name: msg.name,
                            toolName: msg.toolName,
                            toolArgs: msg.toolArgs,
                            isThinking: msg.isThinking,
                            model: msg.modelSlug,
                            sourceId: msg.id,
                            sortOrder: index,
                            createdAt: new Date(msg.timestamp)
                        }))
                    });
                }

                importedCount++;

            } catch (error) {
                console.error(`Failed to import conversation ${rawConv.conversation_id}:`, error);
                // Continue to next conversation
            }
        }
    }

    return importedCount;
}
