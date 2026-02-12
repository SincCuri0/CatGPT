import { v4 as uuidv4 } from "uuid";

/**
 * Pure TypeScript implementation of Microsoft Edge TTS protocol.
 * Uses native WebSockets (Available in Node 22+).
 */
export async function generateEdgeTTS(
    text: string,
    voice: string = "en-US-ChristopherNeural",
    rate: string = "+0%",
    pitch: string = "+0Hz"
): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const uuid = uuidv4().replace(/-/g, "");
        const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=${uuid}`;

        const ws = new WebSocket(url);
        const audioData: Buffer[] = [];
        let isStarted = false;

        ws.onopen = () => {
            // 1. Send Config
            const configMsg = `Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
                JSON.stringify({
                    context: {
                        synthesis: {
                            audio: {
                                metadataoptions: {
                                    sentenceBoundaryEnabled: "false",
                                    wordBoundaryEnabled: "false"
                                },
                                outputFormat: "audio-24khz-48kbitrate-mono-mp3"
                            }
                        }
                    }
                });
            ws.send(configMsg);

            // 2. Send SSML
            const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">` +
                `<voice name="${voice}">` +
                `<prosody rate="${rate}" pitch="${pitch}">${text}</prosody>` +
                `</voice></speak>`;
            const ssmlMsg = `X-RequestId:${uuid}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n${ssml}`;
            ws.send(ssmlMsg);
        };

        ws.onmessage = async (event) => {
            if (typeof event.data === "string") {
                if (event.data.includes("Path:turn.end")) {
                    ws.close();
                    resolve(Buffer.concat(audioData));
                }
            } else if (event.data instanceof ArrayBuffer) {
                // Binary message
                // The first 2 bytes are header length
                const view = new DataView(event.data);
                const headerLength = view.getInt16(0);
                const audioChunk = event.data.slice(headerLength + 2);
                if (audioChunk.byteLength > 0) {
                    audioData.push(Buffer.from(audioChunk));
                }
            }
        };

        ws.onerror = (err) => {
            reject(new Error(`WebSocket error: ${err}`));
        };

        ws.onclose = () => {
            if (audioData.length === 0) {
                reject(new Error("WebSocket closed without receiving audio data"));
            }
        };

        // Timeout fallback
        setTimeout(() => {
            if (ws.readyState === ws.OPEN) ws.close();
            if (audioData.length === 0) reject(new Error("TTS request timed out"));
        }, 15000);
    });
}
