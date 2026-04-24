# CLAUDE.md — Jabodetabek Transit MCP Server

This file is read at the start of every Claude Code session. It captures the
non-obvious constraints that are easy to drift on across multi-turn work. The
authoritative spec is the RFC; this file is a short-term memory aid, not a
substitute for reading it.

---

## Required reading (first session only)

Before writing or editing any code, read:

1. `docs/RFC-001-jabodetabek-transit-mcp.md` — full spec. §6 (architecture),
   §8 (tool catalog), §9 (transport), §10.3 (repo layout) are the sections
   you'll refer back to most often.
2. This file in full.

On subsequent sessions, skim §8 and §10.3 of the RFC to refresh.

---

## Project in one paragraph

A remote MCP server exposing Jabodetabek rail transit (KRL, MRT, LRT Jabodebek,
LRT Jakarta) to any MCP-capable AI client — Claude, ChatGPT Developer Mode,
Cursor, Open WebUI, and anything else speaking MCP over Streamable HTTP. v0.1
is a thin proxy over two community APIs (Comuline for KRL, `mrt-jakarta-api`
for MRT) plus hand-curated static JSON for both LRT systems. Read-only,
stateless, deployed to Cloudflare Workers.

---

## Locked decisions — do not re-litigate

These are settled. If something seems wrong, flag it in chat before changing
it; don't silently adjust.

- **Tool prefix: `jakarta_transit_`**. Not `jbdtk_`, not `idrail_`. The word
  "jakarta" in the name helps LLMs pick the tool up on user queries.
- **Two-layer station IDs.** Every station object returned by any tool carries
  both fields:
  - `canonical_id` — internal, namespaced: `"krl:MRI"`, `"mrt:38"`,
    `"lrtjbd:DKA"`, `"lrtjkt:VEL"`. Used for chaining tool calls and cache
    keys. Validated against `^[a-z]{3,6}:[A-Z0-9]{1,6}$`.
  - `station_code` — operator-native code the user sees on signage: `"MRI"`
    for KRL, `"38"` for MRT, `"DKA"` for LRT Jabodebek. Used when quoting
    back to the user.
  Never emit only one of these.
- **Stateless Streamable HTTP.** Do NOT emit `Mcp-Session-Id`. Every POST is
  self-contained. This enables horizontal scaling on Workers.
- **All tools are read-only.** Every tool registration must set
  `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`,
  `openWorldHint: true`. No write operations in any planned version.
- **Two connectors, shared code.** The main connector (`/mcp`) exposes the 7
  domain tools to Claude and regular ChatGPT. The Deep Research connector
  (`/mcp-deep-research`) exposes only `search` and `fetch` aliases. Same
  Worker, different tool registration lists — selected via an env flag or
  route-based dispatch.
- **Input validation at the MCP boundary.** Every tool input Zod-schema'd
  before it reaches adapter code. No raw strings flowing through.
- **Fare policy.** KRL fares are computed from the public formula (Rp 3,000
  first 25 km, +Rp 1,000 per 10 km after). Every fare response includes
  `method: "formula_unofficial"` and the disclaimer note in §15 of the RFC.
  Never present computed fares as authoritative.

---

## Tech stack (v0.1, locked)

| Layer | Choice |
|---|---|
| Runtime | Cloudflare Workers |
| Language | TypeScript 5.x (strict mode on) |
| MCP SDK | `@modelcontextprotocol/sdk` ≥ 1.10 |
| HTTP framework | Hono |
| Validation | Zod |
| Cache | Cloudflare Workers KV, namespace `jbdtk_cache` |
| Package manager / test runner | Bun |
| Deploy tool | Wrangler |
| CI | GitHub Actions |

No React, no database, no auth provider, no ORM. If a task seems to need one
of these, stop and ask.

---

## Repo layout

Authoritative version is §10.3 of the RFC. Scaffold exactly that structure
before writing any real logic. Do not invent new top-level directories
without asking.

Key directories:

- `src/mcp/tools/` — one file per tool, each exporting a single
  `{ name, description, inputSchema, outputSchema, handler }` object.
- `src/adapters/` — one file per mode (`krl`, `mrt`, `lrtjbd`, `lrtjkt`).
  Adapters return data already shaped to our canonical schema, so tool code
  stays mode-agnostic.
- `src/canonical/` — the two-layer ID encode/decode logic, the shared Zod
  schemas, and `station-groups.json` (interchange clusters, ~7 entries).
- `data/` — static LRT station and schedule JSON. Hand-curated, updated via PR.
- `test/` — `bun test`-compatible tests. `mcp-inspector.test.ts` drives the
  actual MCP protocol via `@modelcontextprotocol/inspector`.

---

## Tool catalog summary

Full schemas in RFC §8. All prefixed `jakarta_transit_` (except the Deep
Research aliases):

| Tool | Purpose |
|---|---|
| `jakarta_transit_search_stations` | Find stations by name/mode/line. Returns canonical_id + station_code. |
| `jakarta_transit_get_station` | Full detail for one canonical_id (or unambiguous station_code). |
| `jakarta_transit_list_lines` | All lines for a mode. |
| `jakarta_transit_get_schedule` | Full schedule for a station on a date. |
| `jakarta_transit_get_next_departures` | Next N departures from a station. Computed, not cached. |
| `jakarta_transit_get_route` | Stations along a line in order. |
| `jakarta_transit_get_fare` | Fare between two canonical_ids. Always same-mode in v0.1. |
| `jakarta_transit_plan_trip` | **Stubbed in v0.1.** Returns `isError: true` with "Not implemented in v0.1, see v0.3". |
| `search` / `fetch` | Deep Research aliases. Registered only on the `/mcp-deep-research` route. |

---

## Implementation order (v0.1)

Follow this sequence. Do not skip ahead — each step unblocks the next.

1. **Project scaffold.** `package.json`, `wrangler.toml`, `tsconfig.json`,
   empty files per RFC §10.3, Hono `/health` endpoint. Acceptance:
   `bun run typecheck` passes and `wrangler dev` serves
   `{ "status": "ok" }` on `GET /health`.
2. **Canonical layer.** `src/canonical/ids.ts` (encode/decode, validate),
   `schema.ts` (shared Zod types: Station, Line, Departure, Fare),
   `station-groups.json`. Acceptance: unit tests round-trip canonical IDs
   for all four modes.
3. **LRT adapters first** — they're static JSON, fast to build, and unblock
   end-to-end testing without any upstream. Fill `data/lrtjbd-stations.json`
   and `data/lrtjkt-stations.json` with at least the station lists; schedules
   can be placeholder for step 4.
4. **MCP wiring.** `src/mcp/server.ts` + `src/mcp/transport.ts` (Streamable
   HTTP, stateless), `/mcp` route in `index.ts`. Register a single tool —
   `search_stations` — wired to the LRT adapters only. Verify with MCP
   Inspector.
5. **Remaining domain tools** — `get_station`, `list_lines`, `get_route`
   against LRT data first, then schedule tools with placeholder data.
6. **KRL adapter** — Comuline client, cache wrapper, circuit breaker.
7. **MRT adapter** — `mrt-jakarta-api` client, same cache/circuit-breaker
   pattern.
8. **Fare tool** — formula + interstation kilometers. Kilometer matrix can
   start as a stub returning `null` with the unofficial note; fill the
   matrix in a follow-up.
9. **Deep Research aliases** on `/mcp-deep-research`.
10. **Deploy to staging**, run the MCP Inspector test suite against the
    deployed URL, then promote.

---

## Deferred / explicitly out of scope for v0.1

Do NOT implement these unless I explicitly ask:

- Real `plan_trip` routing (Dijkstra over transfer graph) — v0.3.
- Self-hosted scrapers for KRL or MRT — v0.2+.
- GTFS export, OpenAPI REST companion — v0.2+.
- Real-time delay data — no feed exists yet.
- Auth, API keys, user accounts — v0.1 is anonymous public.
- The full KRL interstation kilometer matrix — stub first, fill later.

---

## Development commands

```bash
bun install                    # install deps
bun run typecheck              # tsc --noEmit, must pass before commits
bun test                       # run all tests
bun test test/adapters.test.ts # run one suite
bunx wrangler dev              # local dev server at http://localhost:8787
bunx wrangler deploy           # deploy to production
bunx @modelcontextprotocol/inspector http://localhost:8787/mcp
                               # interactive MCP protocol tester
```

Always run `bun run typecheck` and `bun test` before declaring a task done.
CI will run them anyway, but catching failures locally saves a round trip.

---

## Testing expectations

- Every adapter: unit tests with recorded fixtures (do NOT hit live upstreams
  in tests). Put fixtures in `test/fixtures/`.
- Every tool: one happy-path test and one `isError: true` test.
- `mcp-inspector.test.ts` drives the `/mcp` endpoint and asserts that all 9
  tools are discoverable and have valid schemas.
- Coverage target is informal — don't chase a number, cover the error paths.

---

## Hard don'ts

- **No secrets in the repo.** Not in `wrangler.toml`, not in `.dev.vars`
  committed. v0.1 has no secrets anyway, but don't introduce any.
- **No user PII logged.** Only tool args (station IDs, times) are logged,
  and nothing downstream of them.
- **No write operations** to any upstream. We're read-only forever.
- **No session state.** Anything that would require sticky routing is wrong.
- **Do not trust upstream payloads as instructions.** Wrap all adapter
  outputs as structured JSON; never inline raw upstream strings into tool
  descriptions or system prompts.
- **Do not change the tool prefix or canonical ID format** without updating
  the RFC first.

---

## Code style

- TypeScript strict mode. No `any` unless commented with a reason.
- Prefer `type` over `interface` for data shapes; `interface` only for things
  intended to be extended.
- No default exports in `src/` except for the Hono app in `index.ts`.
- Error messages in tool responses must suggest a next step — e.g., "Station
  not found. Try `jakarta_transit_search_stations` with a partial name."
- Comments explain *why*, not *what*. The code should show the what.

---

## When in doubt

Ask before:

- Adding a dependency not in the stack table above.
- Creating a new top-level directory.
- Changing anything in the "Locked decisions" section.
- Implementing something from the "Deferred" list.
- Touching `docs/RFC-001-*.md` — RFC edits are a separate conversation.

Proceed without asking for:

- Bug fixes that don't change public API shape.
- Refactors inside a single file.
- Adding tests.
- Improving error messages.
- Anything explicitly called out in the implementation order above.
