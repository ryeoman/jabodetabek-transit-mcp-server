---
name: RFC Key Decisions
description: All locked decisions from RFC-001 and CLAUDE.md — canonical IDs, tool prefix, transport, fare policy
type: project
---

## Tool prefix
`jakarta_transit_` — never `jbdtk_`, never `idrail_`. Every tool registration uses this prefix exactly.

## Two-layer station IDs (CRITICAL — every station object must have both)
- `canonical_id`: namespaced, machine-friendly, used for chaining tool calls and cache keys. Format: `^[a-z]{3,6}:[A-Z0-9]{1,6}$`. Examples: `krl:MRI`, `mrt:38`, `lrtjbd:DKA`, `lrtjkt:VEL`.
- `station_code`: operator-native, what commuters see on signage. Examples: `MRI`, `38`, `DKA`, `VEL`.
Never emit only one of these — both must be present on every station object in every tool response.

## Transport
Stateless Streamable HTTP. Do NOT emit `Mcp-Session-Id`. Every POST is self-contained. No SSE.

## Tool annotations (every tool)
`readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`

## Two connectors, one codebase
- `/mcp` — 7 `jakarta_transit_*` domain tools (main connector for Claude, ChatGPT, Cursor, etc.)
- `/mcp-deep-research` — only `search` + `fetch` (ChatGPT Deep Research)
Same Worker, same adapters, different tool registration lists.

## Input validation
Every tool input Zod-validated at the MCP boundary before reaching adapter code. No raw strings flowing through.

## Fare policy
- KRL: Rp 3,000 first 25 km + Rp 1,000 per additional 10 km. `method: "formula_unofficial"`.
- MRT: Rp 3,000 base + Rp 1,000/station, capped Rp 14,000. `method: "operator_table_unofficial"`.
- LRT Jabodebek: Rp 5,000 base + Rp 700/additional km. `method: "formula_unofficial"`.
- LRT Jakarta: flat Rp 5,000. `method: "formula_unofficial"`.
Every fare response includes `method` field and the full disclaimer from RFC §8.7.
Cross-mode fare is out of scope for v0.1 — return error suggesting two single-mode legs.

## Origin validation
Allowlist: `claude.ai`, `chatgpt.com`, `openai.com`, `*.cursor.sh`, `http://localhost:*`. Others → 403.

## Error messages
Must suggest a next step. Bad: "Station not found." Good: "Station not found. Try `jakarta_transit_search_stations` with a partial name."

**How to apply:** These are not suggestions — they are locked. Flag in chat before changing any of them.
