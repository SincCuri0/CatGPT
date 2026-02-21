import { NextRequest, NextResponse } from "next/server";
import { scanChatGPTExport } from "@/lib/import/chatgpt-scanner";
import { writeFile, unlink } from "fs/promises";
import path from "path";
import os from "os";
import { v4 as uuidv4 } from "uuid";

export async function POST(req: NextRequest) {
    try {
        const formData = await req.formData();
        const file = formData.get("file") as File;

        if (!file) {
            return NextResponse.json({ error: "No file provided" }, { status: 400 });
        }

        // Save temp file for scanning
        const buffer = Buffer.from(await file.arrayBuffer());
        const tempPath = path.join(os.tmpdir(), `chatgpt-scan-${uuidv4()}.json`);
        await writeFile(tempPath, buffer);

        try {
            const result = await scanChatGPTExport(tempPath);
            return NextResponse.json(result);
        } finally {
            // Cleanup temp file
            await unlink(tempPath).catch(() => { });
        }

    } catch (error) {
        console.error("Scan failed:", error);
        return NextResponse.json({ error: "Failed to scan export file" }, { status: 500 });
    }
}
