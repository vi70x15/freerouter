# FreeLLMProxy Submodule Integration — Kiro-Style Spec

**Status:** v2 — Todd Howard Edition · **Author:** Architect (jCodeMunch-augmented) · **Date:** 2026-06-20

Integrate the Cloudflare Workers proxy layer as a git submodule with **true zero-setup deployment**:
`npm run proxy:up` and you're done. No `.env` editing. No Cloudflare dashboard. No custom domain.
The only prerequisite: `wrangler` on `$PATH` and logged in.

**v2 philosophy change:** v1 assumed manual `ROUTER_DOMAIN` config and Cloudflare dashboard interaction.
v2 eliminates all of that. Workers.dev subdomain is the default. Custom domains are optional.
The system auto-detects its own endpoint URL from wrangler deploy output.

## Documents

| File | Purpose |
|------|---------|
| [REQUIREMENTS.md](./REQUIREMENTS.md) | What must be true when we're done (13 requirement groups, R1–R13) |
| [DESIGN.md](./DESIGN.md) | How it works — workers.dev-first deploy, auto-endpoint detection, env-free UX |
| [TASKS.md](./TASKS.md) | Ordered, delegable implementation steps (11 tasks across 3 phases) |

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Default endpoint | `*.workers.dev` auto-assigned by Cloudflare | Zero config. Custom domain is an optional overlay, not a requirement |
| Router URL discovery | Parse wrangler deploy stdout for published URL | Wrangler prints the URL on every `deploy`. No need to construct it manually |
| Env UX | Fully auto-generated. **Never** requires manual editing for dev/default use | The entire point is `npm run proxy:up` → working endpoint |
| Deploy command | `proxy:up` (not `proxy:deploy`) | Signals the "it just works" intent. `proxy:deploy` remains as an alias |
| Custom domain path | `ROUTER_DOMAIN` in `.env` is **optional override** | If set, router gets `routes = [{ pattern = domain, custom_domain = true }]`. If absent, router gets **no routes section** → workers.dev auto-activates |
| Git relationship | Git submodule (not copy/fork) | Proxy stays independently versioned, tracks upstream `vadash/llm-proxy` |
| `.env` writes | Idempotent bootstrap. Never overwrites existing values | Power users can customize. Defaults work for everyone else |
