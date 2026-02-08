# RFC: Backward-Compatible Coordination Primitives for Multi-Agent Workflows

## Status

- Proposed
- Authors: Engram maintainers
- Last updated: 2026-02-08

## Why

Engram currently provides global memory CRUD (`remember`, `recall`, `forget`) and is effective for single-agent continuity. Delegate-style orchestration needs additional primitives (scoped context, idempotency, resumable coordination) to support concurrent workflows safely.

This RFC defines additive, backwards-compatible changes so existing clients keep working unchanged.

## Goals

- Add scoped memory so multiple assistants/tasks can run without cross-talk.
- Add idempotency controls for safe retries and dedup.
- Add context hydration for orchestration-time prompt assembly.
- Add optional work-item primitives for resumable delegated workflows.
- Preserve full compatibility with existing MCP and HTTP clients.

## Non-Goals

- No removal or rename of existing tools or endpoints.
- No forced migration to scoped mode.
- No mandatory auth change in this RFC.

## Compatibility Contract

1. Existing requests remain valid:
   - `remember(content, category?)`
   - `recall(query, limit?, category?, min_strength?)`
   - `forget(id)`
2. Existing response fields keep current names/types/semantics.
3. New request fields are optional and additive.
4. New response fields are additive only.
5. Existing endpoints remain:
   - `POST /remember`
   - `POST /recall`
   - `POST /forget`
   - `GET /health`
6. With no new fields supplied, behavior must match current global semantics.
7. Database migration is additive only (nullable columns/new tables/indexes).

## Proposed API Extensions (Additive)

### remember

Current fields retained. New optional fields:

- `scope_id?: string`
- `chat_id?: string`
- `thread_id?: string`
- `task_id?: string`
- `metadata?: Record<string, unknown>`
- `idempotency_key?: string`

### recall

Current fields retained. New optional filters:

- `scope_id?: string`
- `chat_id?: string`
- `thread_id?: string`
- `task_id?: string`

### forget

Current fields retained. New optional guard:

- `scope_id?: string` (if provided, delete only within scope)

### New additive endpoints/tools

- `capabilities` (MCP + HTTP) for feature detection
- `context_hydrate` (MCP + HTTP) for orchestration-time context retrieval
- Optional, flagged: `work_items` operations (`create`, `claim`, `heartbeat`, `complete`, `fail`, `cancel`)

## Proposed Schema Extensions (Additive)

### memories table (new nullable columns)

- `scope_id TEXT NULL`
- `chat_id TEXT NULL`
- `thread_id TEXT NULL`
- `task_id TEXT NULL`
- `metadata_json TEXT NULL`
- `idempotency_key TEXT NULL`

### new tables

- `idempotency_ledger`
  - `key TEXT PRIMARY KEY`
  - `operation TEXT NOT NULL`
  - `scope_id TEXT NULL`
  - `created_at TEXT NOT NULL`
  - `result_json TEXT NULL`
- `work_items`
  - state machine row for delegated work
- `work_events`
  - append-only timeline for work item transitions

### indexes

- Scope lookup indexes (scope/chat/thread/task)
- Idempotency lookup index
- Work item state/lease indexes

## Feature Flags

- `ENGRAM_ENABLE_SCOPES`
- `ENGRAM_ENABLE_IDEMPOTENCY`
- `ENGRAM_ENABLE_CONTEXT_HYDRATION`
- `ENGRAM_ENABLE_WORK_ITEMS`

Default for all new flags: disabled.

## Rollout Plan

1. **Phase 0: Contract tests**
   - Capture current MCP/HTTP behavior and lock as regression tests.
2. **Phase 1: Additive DB migration**
   - Add columns/tables/indexes only.
3. **Phase 2: Optional fields in existing APIs**
   - Parse and honor fields only when relevant flags enabled.
4. **Phase 3: Capabilities discovery**
   - Add feature detection endpoint/tool.
5. **Phase 4: Context hydration**
   - Add read-only context retrieval path.
6. **Phase 5: Optional work-items**
   - Add minimal FSM endpoints/tools behind flag.

## Acceptance Criteria

- Old clients against new server: no request changes required, same behavior.
- New optional fields work when flags enabled.
- Flags disabled: behavior equals baseline.
- Existing databases migrate without destructive rewrite.
- `bun run validate` passes.
- `bun run validate:full` behavior remains aligned with known Bun runtime caveat in repository docs.

## Open Questions

- Should `scope_id` default to an explicit value (`global`) in storage, or remain null for legacy rows?
- Should idempotency keys be globally unique or namespaced by operation+scope?
- Do we expose `work_items` over MCP, HTTP, or both in first slice?
