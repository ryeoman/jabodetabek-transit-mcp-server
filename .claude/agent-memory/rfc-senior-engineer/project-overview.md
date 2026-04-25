---
name: Project Overview
description: v0.1 goals, tech stack, locked decisions summary, scaffold status
type: project
---

## Project
Remote MCP server for Jabodetabek rail transit (KRL, MRT, LRT Jabodebek, LRT Jakarta). Read-only, stateless, Cloudflare Workers.

## Scaffold status (Step 1 — COMPLETE as of 2026-04-24)
- `bun run typecheck` passes (exit 0)
- `bun test` runner works (exits 1 only because 0 test files exist yet — correct)
- `wrangler dev` will serve `GET /health` → `{ status: "ok", version: "0.1.0" }`
- `bun` was not pre-installed; installed to `~/.bun/bin/bun` (v1.3.13) during scaffold

## Tech stack (locked)
| Layer | Choice |
|---|---|
| Runtime | Cloudflare Workers |
| Language | TypeScript 5.x strict |
| MCP SDK | @modelcontextprotocol/sdk ^1.10 (installed: 1.29.0) |
| HTTP framework | Hono (installed: 4.12.15) |
| Validation | Zod (installed: 3.25.76) |
| Cache | Cloudflare Workers KV, binding name CACHE, KV namespace jbdtk_cache |
| Package manager / test runner | Bun (1.3.13) |
| Deploy tool | Wrangler (4.84.1) |
| CI | GitHub Actions |

## Key scaffold decisions
- KV binding variable is `CACHE` (not `CACHE_KV` or `jbdtk_cache`) — matches CLAUDE.md over RFC §10.1 which calls it `jakarta_transit_cache`. The binding name in wrangler.toml is `CACHE`; the KV namespace will be named `jbdtk_cache` when created in Cloudflare dashboard.
- `src/mcp/server.ts` is a single stub now; will split into `server-main.ts` + `server-dr.ts` per RFC §10.3 at Step 4 (MCP wiring).
- `bun test` exit code 1 with 0 test files is expected and not a blocker — correct behavior of bun test runner.

**Why:** Constraint from CLAUDE.md says CACHE as binding name; RFC §10.1 says `jakarta_transit_cache` for the namespace name (dashboard-side). These are two different things.

**How to apply:** In wrangler.toml use `binding = "CACHE"`. In TypeScript, reference `env.CACHE`. When creating the KV namespace in Cloudflare dashboard, name it `jbdtk_cache`.
