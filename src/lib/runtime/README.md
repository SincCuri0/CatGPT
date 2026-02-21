# Runtime Rewrite Foundation

This folder is the hard-cut replacement foundation for the runtime internals.

## Included in Phase 1

- `contracts/`
  - typed runtime errors (`RuntimeError`)
  - typed result envelopes (`RuntimeResult`, `ok`, `err`, `attempt`)
- `hooks/`
  - lifecycle hook contracts (`prompt_before`, `prompt_after`, `tool_before`, `tool_after`, `response_stream`, `error_format`, `run_end`)
  - deterministic hook registry with priority ordering
- `infrastructure/`
  - typed event bus abstraction
  - storage adapters (`InMemoryRuntimeKeyValueStore`, `JsonFileRuntimeKeyValueStore`)
- `services/`
  - service lifecycle contracts
  - service registry with startup/shutdown order and health checks
  - semantic memory (`memoryRecallService`)
  - runtime skills loader (`skillsRuntimeService`)
  - tamagotchi prompt injection (`tamagotchiRuntimeService`)
  - secrets masking + placeholders (`secretsService`)
  - scheduler (`taskSchedulerService`)
  - state sync (`stateSyncService`)
  - observability counters (`observabilityService`)
  - MCP runtime abstraction (`mcpRuntimeService`)
- `kernel/`
  - run descriptor and kernel capability contracts

## Migration stance

- No backward-compatibility shims in this layer.
- Old runtime modules are being replaced phase-by-phase.
- Future route/runtime rewrites should import from `@/lib/runtime`.
