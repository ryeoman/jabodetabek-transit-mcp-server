---
name: Architecture Patterns
description: Adapter interface contract, cache key schema, circuit breaker config, MCP error shape, KV TTLs
type: project
---

## Adapter interface (every adapter exports these)
Each of `src/adapters/krl.ts`, `mrt.ts`, `lrtjbd.ts`, `lrtjkt.ts` exports:
- `listStations(): Promise<Station[]>`
- `getStation(id: string): Promise<Station | null>`
- `getSchedule(stationId: string, opts): Promise<Departure[]>`
- `getFare(from: string, to: string): Promise<Fare>`
- `getRoute(trainId: string): Promise<Route>`

Adapters return data already shaped to canonical schema — tool code stays mode-agnostic.

## Cache key schema (KV namespace `jbdtk_cache`)
| Data | Key pattern | TTL |
|---|---|---|
| All stations for a mode | `stations:{mode}` | 24 h |
| One station detail | `station:{mode}:{code}` | 24 h |
| Station schedule for today | `schedule:{mode}:{code}:{YYYY-MM-DD}` | 15 min |
| Line catalog | `lines:{mode}` | 7 d |
| MRT fare | `fare:mrt:{from}:{to}` | 30 d |
| Computed "next N" | not cached | — |

## Circuit breaker config
- Comuline: <= 1 req/sec avg, burst 5. >= 3 consecutive failures -> circuit-break 60 s, serve stale cache.
- MRT API: <= 0.5 req/sec avg, burst 2. Same threshold.
- Static LRT: no circuit breaker needed (in-memory).

## Upstream client config
- 3 s timeout on every upstream fetch
- 1 retry with 250 ms jitter

## MCP error shape
Tool errors return `{ isError: true, content: [{ type: "text", text: "..." }] }` inside a successful JSON-RPC response.
JSON-RPC-level errors (malformed request, unknown tool) use standard JSON-RPC 2.0 error codes.
`jakarta_transit_plan_trip` stub: `{ isError: true, content: [{ type: "text", text: "Not implemented in v0.1, see v0.3. Use jakarta_transit_search_stations + jakarta_transit_get_schedule for each leg." }] }`.

## Logging (structured JSON, no PII)
`{ ts, tool, args_hash, cache_hit, upstream_latency_ms, total_latency_ms, status }`
Only tool args (station IDs, times) logged — nothing downstream of them.

## MCP server instantiation
Fresh McpServer per request (stateless mode) — no session affinity needed, scales horizontally on Workers.

**How to apply:** All new adapters follow this interface exactly. All new cache writes use these key patterns and TTLs. Check these before picking TTL values for any new data type.
