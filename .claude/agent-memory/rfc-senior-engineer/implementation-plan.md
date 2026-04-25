---
name: Implementation Plan
description: 10-step v0.1 implementation sequence with files, acceptance criteria, risks, and open questions
type: project
---

Captured from planning session on 2026-04-24. This is the authoritative step-by-step plan.
Status at capture: repo is empty (only RFC and CLAUDE.md exist).

## Step 1: Project Scaffold
Files: package.json, wrangler.toml, tsconfig.json, .gitignore, all empty src/ files per RFC §10.3, GET /health endpoint
Acceptance: `bun run typecheck` passes, `wrangler dev` returns `{ "status": "ok" }` on GET /health
Unblocks: everything

## Step 2: Canonical Layer
Files: src/canonical/ids.ts, src/canonical/schema.ts, src/canonical/station-groups.json
Acceptance: unit tests round-trip canonical IDs for all four modes
Unblocks: all adapters and all tools

## Step 3: LRT Adapters (static JSON)
Files: data/lrtjbd-stations.json, data/lrtjbd-schedules.json, data/lrtjkt-stations.json, data/lrtjkt-schedules.json, src/adapters/lrtjbd.ts, src/adapters/lrtjkt.ts
Acceptance: adapter unit tests against fixture data (no live network), all station objects have both canonical_id and station_code
Unblocks: MCP wiring (step 4) — provides real data for e2e test without upstream dependency

## Step 4: MCP Wiring (search_stations first)
Files: src/mcp/transport.ts, src/mcp/server-main.ts, src/mcp/server-dr.ts, src/mcp/tools/search-stations.ts, src/index.ts updated with /mcp route
Acceptance: MCP Inspector can discover search_stations tool and call it against LRT data; no Mcp-Session-Id emitted
Unblocks: all remaining tool development

## Step 5: Remaining Domain Tools
Files: src/mcp/tools/get-station.ts, list-lines.ts, get-schedule.ts, get-next-departures.ts, get-route.ts, plan-trip.ts (stub)
Acceptance: each tool has one happy-path test + one isError test; plan_trip returns isError: true immediately
Unblocks: KRL/MRT integration (steps 6-7) can slot in without tool rewrites

## Step 6: KRL Adapter
Files: src/adapters/krl.ts, src/cache.ts (KV wrapper), src/util/retry.ts, test/fixtures/comuline-*.json
Acceptance: adapter unit tests with recorded Comuline fixtures; circuit breaker trips on 3 consecutive failures; all station objects have canonical_id + station_code
Unblocks: full tool coverage for KRL (the busiest mode)

## Step 7: MRT Adapter
Files: src/adapters/mrt.ts, test/fixtures/mrt-*.json
Acceptance: adapter unit tests with recorded fixtures; direction rename hi->northbound / lb->southbound verified; same circuit breaker pattern as KRL
Unblocks: full tool coverage for MRT

## Step 8: Fare Tool
Files: src/mcp/tools/get-fare.ts, src/fare/formulas.ts, src/fare/index.ts, data/distances/krl.json (stub), data/distances/mrt.json, data/distances/lrtjbd.json, data/distances/lrtjkt.json
Acceptance: fare formula tests verify against published tariffs for known pairs; every response has method + disclaimer; cross-mode returns isError with suggestion
Unblocks: nothing (last domain feature)

## Step 9: Deep Research Aliases
Files: src/mcp/tools/dr-search.ts, src/mcp/tools/dr-fetch.ts, src/index.ts updated with /mcp-deep-research route
Acceptance: MCP Inspector on /mcp-deep-research sees only `search` and `fetch`; /mcp still sees only the 7 jakarta_transit_* tools
Unblocks: ChatGPT Deep Research integration

## Step 10: Deploy and Validate
Actions: wrangler deploy to staging, run mcp-inspector.test.ts against deployed URL, smoke-test in Claude and ChatGPT, promote to production
Acceptance: all 9 tools discoverable in mcp-inspector.test.ts; Manggarai schedule query returns in <200 ms p95; zero hardcoded secrets
Unblocks: public announcement / directory submission (deferred to v0.2)

## Open Questions (require clarification before or during implementation)

1. KV namespace name discrepancy: CLAUDE.md says `jbdtk_cache`; RFC §10.1 says `jakarta_transit_cache`. Which binding name goes in wrangler.toml? Recommendation: use `jbdtk_cache` (CLAUDE.md is the working instruction).

2. `get_route` scope: RFC §8.6 says KRL-only in v0.1 because other modes don't expose per-train IDs. But CLAUDE.md step 5 says implement get_route against "LRT data first." LRT has no per-train IDs — the tool will need to return a line's station sequence rather than a train-specific route. Clarify what "route" means for LRT before implementing.

3. `get_schedule` from_time="now" default: the input schema has `from_time` defaulting to `"now"` (a string, not a time). This needs special-case handling in the Zod schema (either a union or a pre-process step). Decide whether "now" is a literal enum value or just the default documentation.

4. `get_station` fallback: RFC §8.2 says the tool also accepts a bare `station_code` if exactly one mode matches. This requires a cross-mode lookup at the boundary. Implement as a secondary lookup pass in the tool handler (not in adapters).

5. CORS origin validation: the allowlist includes `*.cursor.sh` (wildcard subdomain). Cloudflare Workers don't support glob matching natively in headers — implement a regex or explicit check in middleware.

6. `bun test` for mcp-inspector.test.ts: the RFC mentions `@modelcontextprotocol/inspector` as a driver. The inspector is typically a CLI/browser tool, not a programmatic test library. Clarify whether this test file spawns a local wrangler dev process and calls it, or uses a lighter-weight MCP client. Recommendation: use the MCP SDK's own client (`Client` class) directly in the test, not the inspector CLI.

7. LRT schedule synthesis: schedules are stored as first/last/headway. The runtime synthesis function needs a reference time (Jakarta wall clock). Confirm that `src/util/time.ts` will handle Asia/Jakarta timezone via the Temporal API or via `Intl` (Workers support both).
