import { NextRequest, NextResponse } from "next/server";
import { getEnvVariable, setEnvVariable } from "@/lib/env";

export async function GET() {
    try {
        const groqKey = await getEnvVariable("GROQ_API_KEY");
        return NextResponse.json({ apiKey: groqKey });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    try {
        const { apiKey } = await req.json();
        if (apiKey) {
            await setEnvVariable("GROQ_API_KEY", apiKey);
            return NextResponse.json({ success: true, apiKey });
        } else {
            // Delete?
            return NextResponse.json({ error: "API Key required" }, { status: 400 });
        }
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
