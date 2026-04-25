---
name: Data Contracts
description: Upstream API shapes, known gotchas, and static JSON schema for LRT
type: project
---

## Comuline (KRL) — https://api.comuline.com/v1
- `GET /station` → `[{uid, id, name, type, metadata}]` — ~80 stations
- `GET /station/{id}` → single station
- `GET /schedule/{station_id}` → `[{id, station_id, station_origin_id, station_destination_id, train_id, line, route, departs_at, arrives_at, metadata.origin.color}]`
- `GET /route/{train_id}` → full stop sequence
- No auth. Public. AGPLv3. Daily cron refresh at 00:00.
- Risk: free-tier Workers — add 3 s timeout, fall back to stale cache on error.
- Attribution: credit Comuline prominently in README and /docs.

## mrt-jakarta-api — https://mrt-jakarta-api-production.up.railway.app/v1
- `GET /stations` → `[{nid, title, path, urutan, ...}]` — 13 stations
- `GET /station/{nid}` → single station
- `GET /station/{nid}/schedules` → `[{location: "hi"|"lb", times: {weekdays: [...], weekends: [...]}}]` — times as "HH:MM" strings
- `GET /station/{nid}/schedules/now` → next arrivals as millisecond timestamps
- `GET /station/{from}/estimates/{to}` → `{tarif, waktu}` — fare in IDR, time in minutes
- CRITICAL GOTCHA: `location: "hi"` = towards Bundaran HI (northbound); `location: "lb"` = towards Lebak Bulus (southbound). Rename to `direction: "northbound"|"southbound"` in our schema.
- No auth. Rate-limited. Cache aggressively.
- Risk: Railway free-tier, single point of failure. v0.2 contingency: fork and self-host.

## LRT Jabodebek — static JSON
Files: `data/lrtjbd-stations.json`, `data/lrtjbd-schedules.json`
- 18 stations, 2 lines (Cibubur, Bekasi)
- Schedules: first-departure / last-departure / headway per direction per weekday/weekend
- Individual departure times synthesized at runtime from this headway data
- Source: official PDFs from LRT Jabodebek. Manually transcribed. Review quarterly.
- Operator codes (3-letter): DKA (Dukuh Atas), HRM (Harjamukti), etc.

## LRT Jakarta — static JSON
Files: `data/lrtjkt-stations.json`, `data/lrtjkt-schedules.json`
- 6 stations, 1 line
- Flat Rp 5,000 fare regardless of distance
- Source: lrtjakarta.co.id/jadwal.html
- Operator codes (3-letter): VEL (Velodrome), PGD (Pegangsaan Dua Depo), etc.

## Distance matrix
`data/distances/krl.json`, `data/distances/mrt.json`, `data/distances/lrtjbd.json`, `data/distances/lrtjkt.json`
- Station-to-station km, generated from operator's published kilometrage tables
- KRL matrix starts as a stub returning null — fill in follow-up PR
- MRT: operator API returns flat fare, not distance — distance_km will be null in fare response

## Interchange clusters (station-groups.json, ~7 entries)
group_id examples: "dukuh-atas", "manggarai", "juanda", "gambir", "sudirman"
Each group lists canonical_ids of stations physically walkable between modes.

**How to apply:** Before writing any adapter, verify the upstream shape matches these contracts. Flag discrepancies immediately — the MRT direction rename in particular is easy to miss.
