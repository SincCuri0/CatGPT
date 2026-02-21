import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { importChatGPTConversations } from "@/lib/import/chatgpt-mapper";
import { scanChatGPTExport } from "@/lib/import/chatgpt-scanner";
import { ensureDefaultUser } from "@/lib/import/import-utils";
import type { ChatGPTDetails } from "@/lib/import/chatgpt-types";
import path from "path";
import fs from "fs/promises";

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { id, show } = body as { id: string; show: boolean };

        if (!id) {
            return NextResponse.json({ error: "Missing id" }, { status: 400 });
        }

        const user = await ensureDefaultUser();

        // 1. Check if conversation already exists
        const existing = await prisma.conversation.findFirst({
            where: {
                source: "chatgpt",
                sourceId: id,
                userId: user.id
            }
        });

        if (existing) {
            // If exists, just toggle archive status
            // Show = not archived
            // Hide = archived
            await prisma.conversation.update({
                where: { id: existing.id },
                data: { isArchived: !show }
            });

            return NextResponse.json({ success: true, status: show ? "shown" : "hidden" });
        }

        // 2. If not exists and we want to SHOW, we must import it
        if (show) {
            const filePath = path.join(process.cwd(), "ChatGPT Export", "conversations.json");

            // Read and parse
            const raw = await fs.readFile(filePath, "utf-8");
            const allConversations: ChatGPTDetails[] = JSON.parse(raw);
            const target = allConversations.find(c => c.conversation_id === id);

            if (!target) {
                return NextResponse.json({ error: "Conversation not found in export file" }, { status: 404 });
            }

            // Create import record if needed (or just use a generic one)
            // Let's create one for tracking
            const importRecord = await prisma.importRecord.create({
                data: {
                    userId: user.id,
                    source: "chatgpt-local-toggle",
                    filename: "conversations.json",
                    stats: JSON.stringify({ action: "toggle-show", id }),
                }
            });

            // We need scan result for names
            const scanResult = await scanChatGPTExport(filePath);

            await importChatGPTConversations([target], {
                userId: user.id,
                importRecordId: importRecord.id,
                scanResult
            });

            return NextResponse.json({ success: true, status: "imported" });
        }

        // 3. If not exists and we want to HIDE, do nothing (it's already hidden)
        return NextResponse.json({ success: true, status: "already-hidden" });

    } catch (error) {
        console.error("Toggle visibility failed:", error);
        return NextResponse.json({
            error: "Failed to update visibility",
            details: error instanceof Error ? error.message : String(error)
        }, { status: 500 });
    }
}
