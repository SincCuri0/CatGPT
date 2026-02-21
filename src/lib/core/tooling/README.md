# Inter-Agent Tooling Architecture

This module standardizes tools for all agents and providers.

## Core Principles
- Canonical tool schema: Every tool is defined once using `Tool` + `inputSchema`.
- Provider translation: Canonical tools are translated to provider-specific tool definitions.
- Native tool lifecycle only: Provider-native tool calls + provider-native tool result messages.
- Safe execution: Tool arguments are validated before tool execution.

## Modules
- `normalizeTool.ts`: Ensures canonical `inputSchema` defaults are present.
- `providerToolAdapter.ts`: Converts canonical tools into provider tool manifests.
- `toolValidation.ts`: Performs schema-based argument checks.

## Extending Providers
1. Add provider implementation in `src/lib/llm/providers/*`.
2. Map canonical `LLMMessage` history to provider-native message format, including:
   - assistant tool calls
   - tool result messages
3. Map provider tool-call response to `LLMResponse.toolCalls`.
4. Register provider in `ProviderRegistry.ts`.

## Extending Tools
1. Implement a new `Tool` with unique `id`.
2. Define `inputSchema` for arguments.
3. Register the tool in `toolRegistry`.
4. Assign tool IDs to agent configs.

## Self-Writing Tool Path
A director/worker can generate a new tool definition as JSON, persist it, and register it at runtime if:
- file write capability is enabled,
- generated schema passes validation,
- execution sandbox policies allow it.
