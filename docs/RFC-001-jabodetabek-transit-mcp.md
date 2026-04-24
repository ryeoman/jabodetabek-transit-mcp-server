# RFC-001: Jabodetabek Transit MCP Server

| Field | Value |
|---|---|
| **RFC** | 001 |
| **Title** | Jabodetabek Transit MCP Server |
| **Status** | Draft |
| **Author** | <your name> |
| **Created** | 2026-04-24 |
| **Target release** | v0.1 within ~2 weeks of acceptance |
| **Supersedes** | — |

---

## 1. Abstract

This RFC proposes a single remote MCP (Model Context Protocol) server that exposes Jabodetabek rail transit data — KRL Commuter Line, MRT Jakarta, LRT Jabodebek, and LRT Jakarta — to any MCP-capable AI client. It is designed to be consumed by Claude (claude.ai custom connector), ChatGPT (Developer Mode custom connector), and DeepSeek-powered clients (Cursor, Claude Code, Open WebUI, Cherry Studio, OpenRouter, etc.) without any client-specific code paths.

The server is a thin translation layer over two already-live unofficial community APIs (Comuline for KRL, `mrt-jakarta-api` for MRT) plus hand-curated static data for both LRT systems. It does **not** host its own upstream scrapers in v0.1.

## 2. Motivation

1. **Gap in the ecosystem.** Transit MCPs exist for Caltrain, NYC MTA, DART Dallas, Auckland, Renfe, and Malaysia Rapid KL, but none for Indonesia. Jabodetabek is one of the world's largest metro areas (~32M people) and three separate rail operators run here — a prime target.
2. **Natural-language interface wins for transit.** "When's the next train from Manggarai to Bogor?" or "How do I get from Dukuh Atas to Bekasi?" are awkward in existing apps and perfect for an LLM-driven one.
3. **Low build cost.** The two hardest parts (KRL and MRT data) are already solved by the community. Building on top costs us days, not months.
4. **Cross-platform reach with one artifact.** Claude + ChatGPT now both accept remote HTTPS MCP servers. One deploy → three audiences.

## 3. Goals and non-goals

### 3.1 Goals (v0.1)

- **G1** Expose KRL, MRT, LRT Jabodebek, and LRT Jakarta station catalogs through a unified schema.
- **G2** Return scheduled departure times and travel-time/fare estimates for any supported station.
- **G3** Work out-of-the-box in Claude custom connectors and ChatGPT Developer Mode without platform-specific branches.
- **G4** Speak the MCP 2025-03-26 Streamable HTTP transport, stateless mode.
- **G5** Stay under 50 ms median tool-call latency for cached reads from Southeast Asia.
- **G6** Be deployable by one person in one afternoon (Cloudflare Workers + wrangler).

### 3.2 Non-goals (v0.1)

- **NG1** Real-time train positions or live delays — no public feed exists.
- **NG2** Ticketing, payment, or account integration — out of scope for a read-only information tool.
- **NG3** Running our own scrapers against `api-partner.krl.co.id` or `jakartamrt.co.id`. We consume the community wrappers. (Re-evaluated in v0.2.)
- **NG4** Full cross-mode trip planning with optimal transfers — stubbed, implemented in v0.3.
- **NG5** Supporting any mode outside Jabodetabek rail (KRL Yogyakarta, Transjakarta BRT, airport rail link, Whoosh HSR) — in scope only if trivial.

### 3.3 Explicit success metrics

- At least **90% of Manggarai-origin schedule queries** return valid data within 200 ms p95 (Manggarai is the busiest KRL interchange).
- Works end-to-end (add connector → ask question → get answer) on Claude web and ChatGPT web in user testing.
- Zero hardcoded secrets in the repo.

## 4. Background

Summarized from RFC-001 research phase (see companion research notes):

**Available data sources**

| Mode | Source | Type | Status |
|---|---|---|---|
| KRL Commuter | `api.comuline.com/v1` | Public REST, no auth | Live, maintained, AGPLv3 |
| KRL Commuter (upstream) | `api-partner.krl.co.id/krl-webs/v1` | KAI partner backend | Live, bearer JWT, undocumented |
| MRT Jakarta | `mrt-jakarta-api-production.up.railway.app/v1` | Public REST, no auth, rate-limited | Live, community-run on free tier |
| MRT Jakarta (upstream) | `jakartamrt.co.id` | HTML scrape | Live |
| LRT Jabodebek | — | None | Only official site/app; no wrapper exists |
| LRT Jakarta | — | None | Only official site/app; no wrapper exists |

**MCP platform compatibility (April 2026)**

| Platform | Custom MCP connectors | Transport | Notes |
|---|---|---|---|
| Claude (Pro/Max/Team/Enterprise) | Yes, native | Streamable HTTP | Just paste a URL; OAuth optional |
| ChatGPT (Plus/Pro/Business/Enterprise) | Yes, via Developer Mode (beta since 2025-09) | Streamable HTTP only | Deep Research requires `search` + `fetch` tools |
| DeepSeek native chat | No | — | Use DeepSeek *via* any MCP-capable client |

**Transport decision:** MCP spec 2025-03-26 deprecated HTTP+SSE in favor of Streamable HTTP. All new work uses Streamable HTTP. Major vendors (Atlassian Rovo, Keboola) are sunsetting SSE endpoints by mid-2026. We skip SSE entirely.

## 5. Design principles

1. **Thin wrapper first.** v0.1 contains no scraping logic. We proxy to community APIs + a static LRT JSON file. This isolates us from JWT rotations, scrape breakage, and upstream outages we can't fix anyway.
2. **One schema, four modes.** Every tool output uses the same field names (`id`, `name`, `mode`, `lines[]`, etc.) regardless of source. The upstream shape divergence is absorbed in the adapter layer.
3. **ID stability over prettiness.** Station IDs are opaque strings (`krl:MRI`, `mrt:38`, `lrtjbd:DUK`, `lrtjkt:VEL`). Never reuse numeric IDs across modes.
4. **Graceful degradation.** If MRT upstream is down, KRL queries still work. If both are down, static LRT still works. No single upstream can take the whole MCP down.
5. **Read-only.** Every tool has `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`. No write operations in any planned version.
6. **LLM-native output.** Tool descriptions, parameter descriptions, and error messages are written for the LLM caller, not a human reading docs. Examples inline. Errors suggest next-step tools.

## 6. Architecture

```
                  ┌────────────────────────────────────────────┐
                  │    MCP clients                              │
                  │  Claude ─ ChatGPT ─ Cursor ─ Open WebUI ... │
                  └──────────────┬──────────────────────────────┘
                                 │  HTTPS (Streamable HTTP,
                                 │  JSON-RPC 2.0, stateless)
                                 ▼
                  ┌────────────────────────────────────────────┐
                  │  jakarta-transit-mcp-server                 │
                  │  (Cloudflare Worker, TypeScript)            │
                  │                                             │
                  │  ┌──────────────┐   ┌──────────────────┐    │
                  │  │ MCP handler  │──▶│ Tool dispatcher  │    │
                  │  │ (mcp-sdk)    │   └────────┬─────────┘    │
                  │  └──────────────┘            │              │
                  │                              ▼              │
                  │                  ┌────────────────────────┐ │
                  │                  │  Mode adapters         │ │
                  │                  │  ┌────┐ ┌────┐ ┌─────┐ │ │
                  │                  │  │KRL │ │MRT │ │ LRT │ │ │
                  │                  │  └─┬──┘ └─┬──┘ └──┬──┘ │ │
                  │                  └────┼──────┼───────┼────┘ │
                  │                       │      │       │      │
                  │              ┌────────┼──────┼──────ready-only cache (KV, 15 min TTL)
                  │              └────────┼──────┼───────┘      │
                  └──────────────────────┼──────┼───────────────┘
                                          │      │          ▲
                                          │      │          │
                                          ▼      ▼          │
                       ┌──────────────────────────┐   ┌─────┴─────────┐
                       │ Community APIs           │   │ Static JSON   │
                       │ api.comuline.com         │   │ lrt-jbd.json  │
                       │ mrt-jakarta-api…         │   │ lrt-jkt.json  │
                       └──────────────────────────┘   └───────────────┘
```

### 6.1 Layers

- **MCP handler.** Uses `@modelcontextprotocol/sdk` with `StreamableHTTPServerTransport` in **stateless** mode (a fresh `McpServer` per request — simpler to scale on Workers, no session affinity needed). Validates `Origin` and content types per spec.
- **Tool dispatcher.** Maps incoming tool names to handler functions. Centralizes logging, timing, error shaping.
- **Mode adapters.** One TypeScript module per mode. Each exports a uniform interface (`listStations`, `getStation`, `getSchedule`, `getFare`, `getRoute`). Adapters convert upstream responses to our canonical schema.
- **Cache.** Cloudflare KV keyed by `mode:endpoint:args-hash`. TTL: 15 min for schedule data, 24 h for station catalogs, 7 d for line metadata. We do **not** cache "next N departures from now" — those are computed in-process from cached raw schedules.
- **Upstream clients.** Three: `fetch` against Comuline, `fetch` against the MRT API, in-memory static JSON for LRT. All with 3 s timeout, one retry with 250 ms jitter.

### 6.2 Station ID scheme — two layers

**Principle:** we use operator conventions externally (what comes back in tool outputs) and canonical IDs internally (what we key by and pass between tools).

**External — `station_code`.** Whatever the operator uses. A local commuter sees these on signage and in the operator's own app:

| Mode | Source of code | Examples |
|---|---|---|
| KRL | KAI's 2–4 letter codes | `MRI` (Manggarai), `BOO` (Bogor), `JAKK` (Jakarta Kota), `AC` (Angke) |
| MRT | MRT Jakarta's numeric `nid` | `20` (Lebak Bulus), `38` (Bundaran HI), `39` (Dukuh Atas BNI) |
| LRT Jabodebek | Operator 3-letter code | `DKA` (Dukuh Atas), `HRM` (Harjamukti) |
| LRT Jakarta | Operator 3-letter code | `VEL` (Velodrome), `PGD` (Pegangsaan Dua Depo) |

**Internal — `canonical_id`.** Prefix the operator code with the mode, lowercase. This is what gets passed between our tools and used as cache keys:

```
krl:MRI       mrt:38        lrtjbd:DKA        lrtjkt:VEL
```

The prefix exists because "Dukuh Atas" is a station name in KRL, MRT, and LRT Jabodebek with three different operator codes — we need a namespace to disambiguate.

**Every tool output includes both fields** (`canonical_id` and `station_code`) so the LLM can:
- Use `canonical_id` when chaining tool calls (unambiguous, machine-friendly).
- Use `station_code` when quoting back to the user (what they'll actually recognize).

**Interchange clusters.** A `group_id` (e.g. `"dukuh-atas"`) joins stations that are physically walkable between modes. This is hand-curated in `station-groups.json` — only ~7 clusters exist across Jabodetabek. Canonical IDs are listed per group.

## 7. Data sources — detailed contracts

### 7.1 KRL — via Comuline

- **Base:** `https://api.comuline.com/v1`
- **No auth.** Public, open-CORS, AGPLv3.
- **Endpoints we use:**
  - `GET /station` → array of stations with `{uid, id, name, type, metadata}`.
  - `GET /station/{id}` → single station.
  - `GET /schedule/{station_id}` → array of departures with `{id, station_id, station_origin_id, station_destination_id, train_id, line, route, departs_at, arrives_at, metadata.origin.color}`.
  - `GET /route/{train_id}` → full stop sequence.
- **Freshness:** upstream runs a daily 00:00 cron against KAI. We treat as ~24 h fresh.
- **Risk:** free-tier Cloudflare Worker. Add a 3 s timeout and fall back to cached response on error.

### 7.2 MRT Jakarta — via mrt-jakarta-api

- **Base:** `https://mrt-jakarta-api-production.up.railway.app/v1`
- **No auth. Rate-limited.** We cache aggressively.
- **Endpoints we use:**
  - `GET /stations` → array of 13 stations `{nid, title, path, urutan, ...}`.
  - `GET /station/{nid}` → single station.
  - `GET /station/{nid}/schedules` → `[{location: "hi"|"lb", times: {weekdays: [...], weekends: [...]}}]` — times as `HH:MM` strings.
  - `GET /station/{nid}/schedules/now` → next arrivals as millisecond timestamps.
  - `GET /station/{from}/estimates/{to}` → `{tarif, waktu}` — fare in IDR, time in minutes.
- **Semantics gotcha:** `location: "hi"` means "towards Bundaran HI" (northbound); `location: "lb"` means "towards Lebak Bulus" (southbound). We rename these to `direction: "northbound"|"southbound"` in our schema.
- **Risk:** Railway free-tier domain. Single point of failure. Mitigation: fork `reksamamur/mrt-jakarta-api` and self-host as v0.2 contingency.

### 7.3 LRT Jabodebek and LRT Jakarta — static JSON

- **No public API.** We check in two JSON files:

```
/data/lrtjbd-stations.json
/data/lrtjbd-schedules.json
/data/lrtjkt-stations.json
/data/lrtjkt-schedules.json
```

- Schedules are first-departure / last-departure / headway per direction per weekday/weekend. We synthesize individual departure times at runtime.
- **Source of truth:** `lrtjakarta.co.id/jadwal.html`, LRT Jabodebek official schedule PDFs. Manually transcribed. Dated inside each file.
- **Refresh policy:** review quarterly; accept PRs for changes. This is acceptable because LRT schedules change much less often than KRL.
- **v0.2 upgrade path:** build a real scraper if timetables prove to change faster than quarterly in practice.

## 8. MCP tool catalog

All tools are prefixed `jakarta_transit_` so that the LLM picks them up on queries mentioning "Jakarta", "KRL", "MRT", or "LRT" — and to avoid collisions with other transit connectors the user may have installed (Tokyo, KL, etc.). All tools are `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`.

### 8.1 `jakarta_transit_search_stations`

Find stations by name or code, optionally filtered by mode.

**Input** (Zod):
```ts
{
  query: z.string().min(1).describe("Case-insensitive substring of station name or its ID. Examples: 'manggarai', 'MRI', 'dukuh', 'bundaran hi'."),
  mode: z.enum(["krl", "mrt", "lrtjbd", "lrtjkt"]).optional().describe("Restrict to one mode. Omit to search all four."),
  limit: z.number().int().min(1).max(50).default(20),
}
```

**Output** (`outputSchema`):
```ts
{
  results: Array<{
    canonical_id: string,    // internal ID, used for passing between tools. e.g. "krl:MRI"
    station_code: string,    // operator's own code. "MRI" for KRL, "38" for MRT, "DKA" for LRT Jabodebek
    name: string,            // "Manggarai"
    mode: "krl"|"mrt"|"lrtjbd"|"lrtjkt",
    operator: string,        // "KAI Commuter", "PT MRT Jakarta", "KAI", "PT LRT Jakarta"
    lines: string[],         // e.g. ["Bogor Line", "Cikarang Loop", "Soekarno-Hatta Airport"]
    is_interchange: boolean, // true if the physical station serves ≥2 modes
    group_id: string | null, // e.g. "dukuh-atas" — stations you can walk between
  }>,
  total: number,
  has_more: boolean,
}
```

**Notes.** `canonical_id` is the stable identifier to pass to other tools. `station_code` is what a local commuter would actually recognize and should be used when quoting back to the user.

### 8.2 `jakarta_transit_get_station`

Full detail for one station.

**Input:** `{ canonical_id: string }` — e.g. `"krl:MRI"`. The tool also accepts an operator `station_code` if exactly one mode matches (e.g. `"38"` uniquely maps to `mrt:38`), but the LLM is encouraged to pass `canonical_id`.

**Output:**
```ts
{
  canonical_id, station_code, name, mode, operator,
  lines[], is_interchange, group_id,
  location: { latitude: number, longitude: number } | null,
  facilities: string[],        // e.g. ["Elevator", "Parking"]
  first_train_local: string,   // "04:32"
  last_train_local: string,    // "23:58"
  group_members: Array<{       // other stations in the same interchange cluster
    canonical_id: string,
    station_code: string,
    name: string,
    mode: string,
  }>,
  external_url: string | null,
}
```

### 8.3 `jakarta_transit_list_lines`

List lines across modes. Useful for answering "what lines stop at Manggarai?"-adjacent questions when the LLM wants to enumerate.

**Input:** `{ mode?: "krl"|"mrt"|"lrtjbd"|"lrtjkt" }`.

**Output:**
```ts
{
  lines: Array<{
    canonical_id: string,        // "krl:bogor", "mrt:ns", "lrtjbd:cibubur"
    name: string,                // "Bogor Line"
    mode: ...,
    color_hex: string,           // "#DD0067"
    terminus_a_canonical_id: string,
    terminus_b_canonical_id: string,
    station_count: number,
  }>
}
```

### 8.4 `jakarta_transit_get_schedule`

Scheduled departures from a station within a time window.

**Input:**
```ts
{
  station_canonical_id: string,           // e.g. "krl:MRI"
  from_time: z.string().regex(/^\d{2}:\d{2}$/).optional().default("now"),
  to_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  direction: z.enum(["any","northbound","southbound","eastbound","westbound"]).optional(),
  limit: z.number().int().min(1).max(100).default(30),
}
```

**Output:**
```ts
{
  station_canonical_id: string,
  station_code: string,
  timezone: "Asia/Jakarta",
  service_day: "2026-04-24",   // the date these schedules apply to
  is_weekend: boolean,
  departures: Array<{
    departs_at_local: string,               // "15:42"
    departs_at_iso: string,                 // "2026-04-24T15:42:00+07:00"
    line_canonical_id: string,
    line_name: string,
    line_color_hex: string,
    train_id: string | null,                // null for MRT/LRT where per-train IDs aren't exposed
    destination_canonical_id: string,
    destination_station_code: string,
    destination_name: string,
    direction: string | null,
  }>,
  has_more: boolean,
}
```

When `from_time="now"` and `limit<=10` we explicitly label this as "live next departures" in the human-readable form.

### 8.5 `jakarta_transit_get_next_departures`

Convenience: next N departures from "right now" in Jakarta time. Pure wrapper around `jakarta_transit_get_schedule` with `from_time="now"` but named to be obvious to the LLM.

**Input:**
```ts
{
  station_canonical_id: string,
  n: z.number().int().min(1).max(10).default(3),
  direction?: ...,
}
```

**Rationale.** LLMs often pick tools by name-matching the user's phrasing. "Next departures" maps cleanly.

### 8.6 `jakarta_transit_get_route`

Stop sequence for a specific train run. KRL-only in v0.1 (other modes don't expose per-train IDs).

**Input:** `{ train_id: string }` (KRL train IDs are numeric strings like `"2400"`).

**Output:**
```ts
{
  train_id: string,
  line_canonical_id: string,
  origin_canonical_id: string,
  destination_canonical_id: string,
  stops: Array<{
    station_canonical_id: string,
    station_code: string,
    station_name: string,
    departs_at_local: string,
  }>,
}
```

If called with a non-KRL ID, returns a clean error pointing the LLM at `jakarta_transit_get_schedule`.

### 8.7 `jakarta_transit_get_fare`

Fare and estimated time between two stations within the same mode. **All fares are computed from publicly published formulas and may not match the actual fare charged at the gate.** Every response includes a disclaimer.

**Input:**
```ts
{
  origin_canonical_id: string,       // e.g. "krl:MRI"
  destination_canonical_id: string,  // must share a mode with origin
}
```

**Output:**
```ts
{
  origin_canonical_id, destination_canonical_id,
  mode: ...,
  fare_idr: number,                  // 3000, 4000, 9000, ...
  estimated_minutes: number,
  distance_km: number | null,        // null for MRT (operator API returns flat fare, not distance)
  method: "formula_unofficial" | "operator_table_unofficial",
  formula_reference: string,         // human-readable description of the calculation
  disclaimer: string,                // always present
}
```

**`method` values:**
- `"formula_unofficial"` — KRL and LRT. Computed from the published distance-based formula + an internal station-km matrix.
- `"operator_table_unofficial"` — MRT. Sourced from the `mrt-jakarta-api` estimates endpoint, which itself scrapes the official calculator.

**Per-mode formulas (v0.1):**

| Mode | Formula | Source |
|---|---|---|
| KRL | Rp 3,000 for the first 25 km, + Rp 1,000 per additional 10 km | KAI Commuter published tariff |
| MRT | Rp 3,000 base + Rp 1,000 per station, capped at Rp 14,000 | PT MRT Jakarta published tariff (verified against upstream API) |
| LRT Jabodebek | Rp 5,000 base + Rp 700 per additional km | KAI published tariff |
| LRT Jakarta | Flat Rp 5,000 regardless of distance | PT LRT Jakarta published tariff |

**Disclaimer (always included verbatim in every fare response):**
> "This fare is unofficial — computed from the operator's publicly published tariff formula. Actual fare at the gate may differ due to promotions, integrated-journey caps (e.g. Jak Lingko), surge pricing, or formula updates we haven't mirrored yet. Verify at station e-kiosks or the official operator app (KAI Access / MRTJ / LRTJ) before travel."

**Cross-mode fare** is explicitly out of scope in v0.1. If `origin` and `destination` don't share a mode, the tool returns an error suggesting the LLM compute two single-mode legs and note that Jak Lingko integration may reduce the total.

**Station-to-station distance matrix:** checked into `/data/distances/` as one JSON file per mode. Generated once from the operator's published kilometrage tables. Peer-reviewed via PR.

### 8.8 `jakarta_transit_plan_trip` *(v0.3 — stub in v0.1)*

Will return a multi-leg journey with transfers. v0.1 implementation returns `{ error: "not yet implemented", suggestion: "use jakarta_transit_search_stations + jakarta_transit_get_schedule for each leg" }` so the LLM gets a useful pointer, not a crash.

### 8.9 Two connectors, one codebase

v0.1 ships **two deployed URLs** from the same repo:

| Connector | URL | Tools exposed | Consumers |
|---|---|---|---|
| **Main** | `https://<host>/mcp` | The 7 `jakarta_transit_*` domain tools above | Claude custom connectors, ChatGPT Developer Mode, Cursor, Open WebUI, Cherry Studio, any MCP client |
| **Deep Research** | `https://<host>/mcp-deep-research` | Only `search` and `fetch` | ChatGPT Deep Research mode |

Both share the same adapters, cache, and domain logic — the only difference is which tool list gets registered on the `McpServer`. This avoids the awkwardness of having generic `search`/`fetch` in the main tool catalog where they'd compete with `jakarta_transit_search_stations` for LLM selection.

- `search(query: string) -> { ids: string[] }` — canonical station IDs. ChatGPT decides which to fetch.
- `fetch(id: string) -> { id, title, text, url?, metadata? }` — resolves a canonical station ID or train ID into a dense text blob + metadata suitable for retrieval-style synthesis.

Users of the Deep Research connector see only these two tools; users of the main connector never see them. Clean separation.

### 8.10 Tool call budget

Main connector = **7 tools**. Deep Research connector = **2 tools**. Both comfortably under the threshold where LLMs start struggling with selection.

## 9. Transport and protocol

- **MCP version:** protocol revision `2025-03-26` (Streamable HTTP introduced here).
- **Transport:** HTTPS Streamable HTTP, two endpoints served from the same Worker:
  - `POST /mcp` → main connector (7 `jakarta_transit_*` tools).
  - `POST /mcp-deep-research` → Deep Research connector (only `search` + `fetch`).
  Both also accept `GET` to return a valid-but-empty SSE stream, which satisfies clients that probe for server-initiated messages.
- **Statelessness:** no session — every POST is self-contained. We do not emit `Mcp-Session-Id`. This simplifies horizontal scaling on Workers and avoids sticky routing.
- **Content types:** `application/json` for single responses; we do **not** upgrade to `text/event-stream` in v0.1 since no tool streams partial results.
- **Origin validation:** `Origin` header must match a known allowlist (`claude.ai`, `chatgpt.com`, `openai.com`, `*.cursor.sh`, local `http://localhost:*`). Any other Origin → `403`.
- **CORS:** `Access-Control-Allow-Origin` reflects the allowed Origin (not `*`); `Access-Control-Allow-Methods: POST, GET, OPTIONS`; `Access-Control-Allow-Headers: Content-Type, Mcp-Session-Id, Authorization`.
- **Rate limiting:** 30 req/min/IP via Cloudflare's built-in rate-limit rules. 429 response includes a `Retry-After` header. Our own upstream calls are separately throttled — see §12.
- **Error model:** tool errors return `{ isError: true, content: [...] }` inside a successful JSON-RPC response, per MCP spec. JSON-RPC-level errors (malformed request, unknown tool) use standard JSON-RPC 2.0 error codes.

## 10. Deployment

### 10.1 Reference stack

- **Runtime:** Cloudflare Workers (same as Comuline, same latency profile for the SEA region).
- **Language:** TypeScript 5.x.
- **SDK:** `@modelcontextprotocol/sdk` ≥ 1.10.
- **Framework:** Hono (matches Comuline's choice; tiny; runs on Workers natively).
- **Cache:** Cloudflare Workers KV (one namespace: `jakarta_transit_cache`).
- **Secrets:** none required for v0.1. Reserved env vars: `CHATGPT_DEEP_RESEARCH_ENABLED` (default `true`), `CORS_ALLOWLIST`.

### 10.2 Alternative stack

- **Fly.io + Bun + Hono** — same code, different host. Chosen if Workers' KV consistency causes problems.
- **Railway + Node + Express** — fallback for people who prefer long-running processes.

### 10.3 Repo layout

```
jakarta-transit-mcp-server/
├── src/
│   ├── index.ts                # Worker entry: Hono app, /mcp + /mcp-deep-research endpoints
│   ├── mcp/
│   │   ├── server-main.ts      # Registers the 7 jakarta_transit_* tools
│   │   ├── server-dr.ts        # Registers only search + fetch for Deep Research
│   │   ├── transport.ts        # StreamableHTTPServerTransport (stateless)
│   │   └── tools/
│   │       ├── search-stations.ts
│   │       ├── get-station.ts
│   │       ├── list-lines.ts
│   │       ├── get-schedule.ts
│   │       ├── get-next-departures.ts
│   │       ├── get-route.ts
│   │       ├── get-fare.ts
│   │       ├── plan-trip.ts    # stub
│   │       ├── dr-search.ts    # Deep Research only
│   │       └── dr-fetch.ts     # Deep Research only
│   ├── adapters/
│   │   ├── krl.ts              # Comuline client
│   │   ├── mrt.ts              # mrt-jakarta-api client
│   │   ├── lrtjbd.ts           # static JSON loader
│   │   └── lrtjkt.ts           # static JSON loader
│   ├── canonical/
│   │   ├── ids.ts              # encode/decode "mode:operator_code"
│   │   ├── station-groups.json # interchange clusters (Manggarai, Dukuh Atas, …)
│   │   └── schema.ts           # Zod types shared across adapters
│   ├── fare/
│   │   ├── formulas.ts         # KRL/MRT/LRT fare formulas with unofficial disclaimer
│   │   └── index.ts
│   ├── cache.ts                # KV wrapper
│   └── util/
│       ├── time.ts             # Asia/Jakarta helpers
│       └── retry.ts
├── data/
│   ├── lrtjbd-stations.json
│   ├── lrtjbd-schedules.json
│   ├── lrtjkt-stations.json
│   ├── lrtjkt-schedules.json
│   └── distances/              # station-to-station km, one file per mode
│       ├── krl.json
│       ├── mrt.json
│       ├── lrtjbd.json
│       └── lrtjkt.json
├── test/
│   ├── adapters.test.ts
│   ├── tools.test.ts
│   ├── fare.test.ts            # verify formula outputs against published tariffs
│   └── mcp-inspector.test.ts   # driven by @modelcontextprotocol/inspector
├── wrangler.toml
├── package.json
├── tsconfig.json
└── README.md
```

### 10.4 CI/CD

- **CI:** GitHub Actions. On PR: `bun install` → `bun run typecheck` → `bun test` → `bun run build`.
- **CD:** on merge to `main`, `wrangler deploy` with staging namespace. Manual promotion to production via tag `v*`.
- **Data refresh:** no runtime sync (we're a proxy in v0.1). LRT static JSON bumped via PR.

### 10.5 Health and readiness

- `GET /` → redirects to `/docs` (human landing).
- `GET /health` → `{ status: "ok", version: "0.1.0", upstreams: { comuline: "ok"|"degraded"|"down", mrt: ..., lrt: "static" } }`.
- `GET /docs` → Scalar-rendered OpenAPI for the optional `/v1/*` REST companion (see §16).

## 11. Client integration

### 11.1 Claude

User side:
1. Claude settings → Connectors → Add custom connector.
2. Paste `https://<your-host>/mcp`.
3. No auth in v0.1.

Works on Pro, Max, Team, Enterprise. Free users capped at one custom connector.

### 11.2 ChatGPT

**Regular chat / Developer Mode:**
1. Enable Developer Mode (Settings → Connectors → Advanced → Developer Mode).
2. Create custom connector, URL = `https://<your-host>/mcp`.
3. No auth required.

**Deep Research mode:**
1. Create a *separate* custom connector.
2. URL = `https://<your-host>/mcp-deep-research`.
3. No auth required.

**Caveats:**
- Plus and Pro plans get read-only custom connectors in Dev Mode — fine for us since we're read-only.
- Memory auto-disables in Dev Mode.
- Users who want both regular-chat tools and Deep Research add both connectors.

### 11.3 DeepSeek-powered clients

`chat.deepseek.com` itself has no MCP surface. But DeepSeek as a model behind an MCP-capable client works:

- **Cursor** / **Claude Code** / **Open WebUI** / **Cherry Studio** → paste the same URL as an MCP server entry in their config.
- **OpenRouter** with DeepSeek → use Composio or an MCP-aware agent framework.

Documentation should make this clear and point users to the specific client they're using.

## 12. Caching, resilience, rate limiting

### 12.1 Cache keys and TTLs

| Data | Key | TTL |
|---|---|---|
| All stations, one mode | `stations:krl` etc. | 24 h |
| One station detail | `station:krl:MRI` | 24 h |
| Station schedule for today | `schedule:krl:MRI:2026-04-24` | 15 min (upstream only refreshes daily but service changes mid-day occasionally) |
| Line catalog | `lines:krl` | 7 d |
| MRT fare | `fare:mrt:20:39` | 30 d (fares change rarely) |
| Computed "next N" | not cached | — |

### 12.2 Upstream budget

- Comuline: ≤ 1 req/sec average, burst 5. If we see ≥3 consecutive failures, circuit-break for 60 s and serve stale cache.
- MRT API: ≤ 0.5 req/sec average, burst 2. Same circuit-breaker.
- Static LRT: infinite, it's in memory.

### 12.3 Failure modes

| Scenario | Behavior |
|---|---|
| Cache hit | Return immediately. |
| Cache miss, upstream OK | Fetch, cache, return. |
| Cache miss, upstream 5xx | Return error with suggestion: "try again in a few seconds; alternatively use mode=..." |
| Cache miss, upstream timeout | Same as 5xx. |
| All upstreams down | Static LRT still works. KRL/MRT tools return `{ isError: true }` with a clear message. |

### 12.4 Observability

- Structured JSON logs on every tool call: `{ ts, tool, args_hash, cache_hit, upstream_latency_ms, total_latency_ms, status }`.
- Sent to Cloudflare Logpush → Axiom or to Better Stack.
- Metric of truth: **tool call success rate by tool name**.

## 13. Security

- **No secrets in v0.1.** No API keys stored, no user credentials handled. We are a read-only proxy over public data.
- **PII.** None handled. No logging of user prompts — we only see tool args, which are station IDs and times.
- **Input validation.** All inputs Zod-schema'd at the MCP boundary. Station IDs restricted to `^[a-z]{3,6}:[A-Z0-9]{1,6}$`. Times to `^\d{2}:\d{2}$`.
- **DoS.** Cloudflare's 30 req/min/IP plus our upstream circuit-breakers. If an attacker burns through our upstream budget, static LRT still serves.
- **Prompt injection.** Upstream payloads are not treated as instructions. Tool output strings are wrapped in code blocks / structured JSON so downstream LLMs don't confuse data with instructions.
- **Origin validation.** As described in §9 — allowlist only.

## 14. Phased roadmap

| Version | Scope | Est. effort |
|---|---|---|
| **v0.1** | This RFC. 9 tools. KRL via Comuline, MRT via community API, LRT static. Claude + ChatGPT ready. | ~3–5 days |
| **v0.2** | Self-host the MRT scraper (fork `reksamamur/mrt-jakarta-api`). Add OpenAPI REST companion endpoints so non-MCP clients can consume. Metrics dashboard. | ~1 week |
| **v0.3** | `jakarta_transit_plan_trip` real implementation — hand-built transfer graph, Dijkstra over scheduled times. Real-time-ish delay hints if any feed surfaces. | ~1 week |
| **v0.4** | Additional modes: Soekarno-Hatta Airport Rail Link (KAI Commuter), KRL Yogyakarta (Comuline already has it), Whoosh HSR if feasible. Evaluation harness with 20 Q&A pairs per mcp-builder skill. | ~1 week |
| **v1.0** | Our own KRL scraper (eliminate Comuline dependency). Proper GTFS export. Submit to `gtfs.org` producer list. | ~2 weeks |

## 15. Open questions and decisions

### 15.1 Resolved (2026-04-24)

1. ~~**Naming.**~~ **Decided:** tool prefix is `jakarta_transit_`. Rationale: the LLM sees tool names during selection, so having "jakarta" and "transit" literally in the name improves tool-picking accuracy when the user says "Jakarta train" or "transit in Jakarta". Worth the verbosity.
2. ~~**LRT station naming.**~~ **Decided:** use the operator's own codes externally (`station_code`), prefixed canonical IDs internally (`canonical_id = "mode:code"`). Every tool output returns both. Details in §6.2.
3. ~~**Fare computation.**~~ **Decided:** compute from published formulas for all four modes. Every fare response carries a standard unofficial-computation disclaimer and a `method` field distinguishing `formula_unofficial` (KRL, LRT) from `operator_table_unofficial` (MRT). See §8.7 for the four formulas and the fixed disclaimer text.
4. ~~**ChatGPT Deep Research.**~~ **Decided:** two connectors, one codebase. Separate URLs (`/mcp` and `/mcp-deep-research`) keep tool lists clean. Same adapters and cache.

### 15.2 Still open

5. **Cross-mode fare.** Jak Lingko integration exists but mixed-mode fare calculation is non-trivial. Defer to v0.3 when `plan_trip` lands — at that point we'll have travel legs and can apply integration caps.
6. **Attribution.** Comuline is AGPLv3. We consume their API rather than redistributing their source, so reach is arguably limited, but we should (a) credit them prominently in the README and in the `/docs` page, and (b) revisit the licensing question if we fork their sync code in v0.2+. Sanity-check with a licence-aware human before v1.0.
7. **Do we need evals?** Per the `mcp-builder` skill, yes — 10 realistic Q&A pairs. Proposal: carve out half a day before v0.1 cut to write them. They'll surface integration problems that unit tests won't.
8. **Register in MCP directories?** Anthropic MCP Registry, mcpservers.org, Glama, Smithery. Proposal: yes, after v0.2 when self-hosted MRT removes the most fragile external dependency.

## 16. Appendices

### A. Example: "When's the next train from Manggarai to Bogor?"

LLM reasoning (ideal path):
1. Calls `jakarta_transit_search_stations(query="manggarai")` → `[{canonical_id: "krl:MRI", station_code: "MRI", ...}]`.
2. Calls `jakarta_transit_search_stations(query="bogor")` → `[{canonical_id: "krl:BOO", station_code: "BOO", ...}]`.
3. Calls `jakarta_transit_get_next_departures(station_canonical_id="krl:MRI", n=3, direction="southbound")`.
4. Filters client-side for departures whose `destination_canonical_id == "krl:BOO"`.
5. Answers: "The next Bogor-bound trains from Manggarai (MRI) are at 15:42 (train 2412, Bogor Line), 15:51, 16:02."

### B. Example: Deep Research mode

User has added the **Deep Research connector URL** (`/mcp-deep-research`) separately:

1. Calls `search(query="Dukuh Atas interchange stations")` → `{ ids: ["krl:SUD", "mrt:38", "lrtjbd:DKA"] }`.
2. Calls `fetch(id="krl:SUD")`, `fetch(id="mrt:38")`, `fetch(id="lrtjbd:DKA")` in sequence.
3. Synthesizes a comparative writeup from the returned text blobs.

The Deep Research connector sees **only** `search` and `fetch` in its tool list — the `jakarta_transit_*` tools live on a different URL.

### C. Minimum viable station dataset sizes

| Mode | Stations | Lines | Schedule entries/day |
|---|---|---|---|
| KRL | ~80 | 6 | ~1,000 |
| MRT Jakarta | 13 | 1 (North-South) | ~200 per direction |
| LRT Jabodebek | 18 | 2 (Cibubur, Bekasi) | ~220 |
| LRT Jakarta | 6 | 1 | ~110 |
| **Total** | ~117 | 10 | ~1,550 |

Small enough that the entire catalog fits comfortably in a single KV entry per mode.

### D. References

1. MCP Specification 2025-03-26 — Streamable HTTP transport: <https://modelcontextprotocol.io/specification/2025-03-26/basic/transports>
2. Comuline API — <https://github.com/comuline/api>, <https://api.comuline.com/docs>
3. mrt-jakarta-api — <https://github.com/reksamamur/mrt-jakarta-api>
4. ChatGPT Developer Mode / MCP — <https://help.openai.com/en/articles/12584461>
5. Claude custom connectors — claude.ai Settings → Connectors
6. mcp-builder skill (internal) — tool naming, response format, annotations

---

**Next step after approval:** scaffold the repo per §10.3, implement adapters + first 3 tools (`jakarta_transit_search_stations`, `jakarta_transit_get_station`, `jakarta_transit_get_schedule`), smoke-test end-to-end in Claude and ChatGPT. Target: working demo in ≤ 3 days.
