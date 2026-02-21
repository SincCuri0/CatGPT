
import { useEffect, useRef } from "react";

interface RuntimeStateEvent {
    channel: string;
    type: string;
    payload: Record<string, unknown>;
    timestamp: number;
}

interface UseEventSubscriptionOptions {
    channel?: string | string[]; // Specific channel(s) to filter by. If omitted, consumes all from the stream (which might be filtered by the API query)
    onEvent: (event: RuntimeStateEvent) => void;
    enabled?: boolean;
}

/**
 * Hook to subscribe to Server-Sent Events (SSE) from the runtime state API.
 * Replaces the legacy WebSocket-based useRealtime hook.
 */
export function useEventSubscription({
    channel,
    onEvent,
    enabled = true,
}: UseEventSubscriptionOptions) {
    const onEventRef = useRef(onEvent);

    useEffect(() => {
        onEventRef.current = onEvent;
    }, [onEvent]);

    useEffect(() => {
        if (!enabled) return;

        // Use the runtime state API with stream=1
        // We can filter by channel in the query param if it's a single channel
        const params = new URLSearchParams();
        params.set("stream", "1");

        // If a single channel is provided, we can optimize the subscription on the server side
        // If multiple channels or wildcards, we consume the default stream and filter client-side
        // Note: The current API implementation mainly supports one channel param "channel" or "agentId"/"runId".
        // For broad monitoring, we might just connect to the default or a "system" channel if available, 
        // but the previous useRealtime relied on "channels" array.
        // Let's assume for now we connect to the requested channel if single, or "default" if complex/wildcard.

        let targetChannel = "default";
        if (typeof channel === "string" && !channel.includes("*")) {
            targetChannel = channel;
            params.set("channel", channel);
        }

        const url = `/api/runtime/state?${params.toString()}`;
        const eventSource = new EventSource(url);

        eventSource.onmessage = (event) => {
            // This catches "message" events, which might be the snapshot or heartbeat
            // The API sends "event: event" for actual updates
        };

        eventSource.addEventListener("event", (e) => {
            try {
                const data = JSON.parse(e.data) as RuntimeStateEvent;

                // Client-side filtering if needed
                if (channel) {
                    const channels = Array.isArray(channel) ? channel : [channel];
                    const match = channels.some(c => {
                        if (c === "*") return true;
                        if (c.endsWith(":*")) return data.channel.startsWith(c.slice(0, -2));
                        return data.channel === c;
                    });
                    if (!match) return;
                }

                onEventRef.current(data);
            } catch (err) {
                console.error("Failed to parse SSE event:", err);
            }
        });

        eventSource.onerror = (err) => {
            // EventSource automatically reconnects, but we log for debugging
            console.debug("SSE connection error (will reconnect):", err);
        };

        return () => {
            eventSource.close();
        };
    }, [channel, enabled]);
}
