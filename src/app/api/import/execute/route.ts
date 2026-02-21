import { NextRequest, NextResponse } from "next/server";
import { importChatGPTConversations } from "@/lib/import/chatgpt-mapper";
import { ensureDefaultUser } from "@/lib/import/import-utils";
import { prisma } from "@/lib/db";
import type { ChatGPTDetails, ExportScanResult } from "@/lib/import/chatgpt-types";



export async function POST(req: NextRequest) {
    try {
        const formData = await req.formData();
        const file = formData.get("file") as File;
        const scanResultJson = formData.get("scanResult") as string;
        const selectedIdsJson = formData.get("selectedIds") as string | null;

        if (!file || !scanResultJson) {
            return NextResponse.json({ error: "Missing file or scanResult" }, { status: 400 });
        }

        const scanResult: ExportScanResult = JSON.parse(scanResultJson);
        const selectedIds = selectedIdsJson ? JSON.parse(selectedIdsJson) as string[] : [];
        const hasSelection = selectedIds.length > 0;

        // 1. Get User (still needed for import record association if not removed)
        const user = await ensureDefaultUser();

        // 2. Parse File content
        const buffer = Buffer.from(await file.arrayBuffer());
        const jsonText = buffer.toString("utf-8");
        const allConversations: ChatGPTDetails[] = JSON.parse(jsonText);

        // FILTER HERE
        const filteredConversations = hasSelection
            ? allConversations.filter(c => selectedIds.includes(c.conversation_id))
            : allConversations;

        // 3. Create Import Record
        const importRecord = await prisma.importRecord.create({
            data: {
                userId: user.id,
                source: "chatgpt",
                filename: file.name,
                stats: JSON.stringify({
                    fileSize: file.size,
                    totalItems: filteredConversations.length,
                    status: "processing"
                }),
            },
        });

        // 4. Run Import
        const count = await importChatGPTConversations(filteredConversations, {
            userId: user.id,
            importRecordId: importRecord.id,
            scanResult
        });

        return NextResponse.json({
            success: true,
            importedConversations: count,
            importRecordId: importRecord.id
        });

    } catch (error) {
        console.error("Import execution failed:", error);
        return NextResponse.json({
            error: "Import failed",
            details: error instanceof Error ? error.message : String(error)
        }, { status: 500 });
    }
}
