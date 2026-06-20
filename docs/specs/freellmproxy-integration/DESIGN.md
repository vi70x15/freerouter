# Design — FreeLLMProxy Submodule Integration (v2 — Todd Howard Edition)

---

## D1: Current Architecture (As-Is)

```
~/freellmapi/                         ~/freeproxy/
├── server/  (Express + SQLite)        ├── src/
├── client/  (React + Vite)           │   ├── worker.ts       (dispatch by WORKER_ROLE)
├── shared/  (Types)                  │   ├── router.ts       (auth, URL decode, proxy select)
├── scripts/cli.mjs                   │   ├── proxy.ts        (header strip, fake IP, upstream fetch)
└── package.json                      │   ├── fake-ip.ts / base64url.ts / http.ts
                                       │   ├── public.ts      (URL encoder page)
                                       │   └── url-normalize.ts / regions.txt
                                       ├── scripts/deploy.ts  (TOML gen + wrangler deploy)
                                       ├── wrangler.toml      (base config for dev)
                                       └── package.json
```

Two separate repos. The proxy requires `ROUTER_DOMAIN` in `.env` and hardcodes `routes = [{ pattern, custom_domain = true }]` in every generated router TOML. No workers.dev path exists.

---

## D2: Target Architecture (To-Be)

```
~/freellmapi/
├── server/
├── client/
├── shared/
├── scripts/
│   ├── cli.mjs                (api start/stop)
│   └── proxy-up.mjs           ← NEW: full orchestrator
├── freellmproxy/              ← GIT SUBMODULE (no source changes needed)
│   ├── src/                   (unchanged)
│   ├── scripts/deploy.ts      (unchanged — but called differently, see D6)
│   ├── .env                   (auto-generated, no ROUTER_DOMAIN by default)
│   └── node_modules/          (installed via postinstall)
├── .gitmodules                ← NEW
├── package.json               ← MODIFIED: add scripts + postinstall
└── .github/workflows/ci.yml   ← MODIFIED: add submodule checkout
```

The orchestration script `proxy-up.mjs` replaces `proxy-integrate.mjs`. Same role, better name, more capabilities.

---

## D3: The `proxy:up` Flow

This is the core design. Everything flows from here.

```
npm run proxy:up
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│  1. WRANGLER CHECK                                          │
│     which wrangler → found?                                 │
│     ├─ NO  → ⚠️ wrangler not found. Install: ...  → exit 1 │
│     └─ YES → wrangler whoami → exits 0?                    │
│              ├─ NO  → ⚠️ wrangler not logged in. Run: ...  │
│              │        → exit 1                              │
│              └─ YES → continue                              │
│                                                             │
│  2. SUBMODULE + DEPS                                        │
│     freellmproxy/ exists?                                   │
│     ├─ NO  → .git/modules/freellmproxy?                    │
│     │        ├─ YES → git submodule update --init --rec     │
│     │        └─ NO  → ⚠️ skipping → exit 1                 │
│     └─ YES → freellmproxy/node_modules?                     │
│              └─ NO → npm install --prefix freellmproxy      │
│                                                             │
│  3. ENV BOOTSTRAP                                           │
│     freellmproxy/.env exists?                               │
│     ├─ YES → read it (never overwrite)                     │
│     └─ NO  → generate:                                     │
│          AUTH_KEY = randomBytes(16).hex slice(0,16)         │
│          INTERNAL_AUTH_SECRET = randomBytes(32).hex         │
│          PROXY_COUNT=3                                      │
│          (NO ROUTER_DOMAIN — workers.dev default)           │
│                                                             │
│  4. DEPLOY (via proxy's deploy.ts)                         │
│     Load .env into process.env                              │
│     Detect ROUTER_DOMAIN in .env:                           │
│       ├─ ABSENT → router TOML gets NO routes section        │
│       │           → workers.dev auto-activates              │
│       └─ PRESENT → router TOML gets routes=[{pattern,...}]  │
│                   → custom domain overrides workers.dev     │
│     Spawn: npx tsx scripts/deploy.ts                        │
│       cwd: freellmproxy/                                    │
│       stdio: pipe (to capture stdout for URL extraction)     │
│                                                             │
│  5. EXTRACT ENDPOINT URL                                    │
│     Parse deploy.ts stdout for:                             │
│       /https:\/\/[^\s]+workers\.dev/                        │
│     Fallback if not found:                                  │
│       wrangler whoami --json → account name → construct URL │
│                                                             │
│  6. PERSIST DETECTED URL                                    │
│     If DETECTED_ROUTER_URL not in .env:                      │
│       append DETECTED_ROUTER_URL=<url> to .env              │
│                                                             │
│  7. PRINT "READY" BLOCK                                     │
│     🚀 READY                                                │
│                                                             │
│     Router URL:  https://llm-proxy-router.xxx.workers.dev   │
│     Auth key:    a1b2c3d4e5f6a7b8                           │
│                                                             │
│     Example request:                                        │
│     POST https://llm-proxy-router.xxx.workers.dev/          │
│          a1b2c3d4e5f6a7b8/1/<BASE64_URL>                    │
└─────────────────────────────────────────────────────────────┘
```

---

## D4: Workers.dev vs Custom Domain — How It Works

### Cloudflare Workers routing (platform behavior, not our code)

When a Worker is deployed:

| Scenario | TOML `routes` section | Result |
|----------|----------------------|--------|
| **No routes** | Omitted | Worker is accessible at `https://<name>.<subdomain>.workers.dev` |
| **Custom domain route** | `routes = [{ pattern = "my.domain", custom_domain = true }]` | Worker is accessible at `https://my.domain/`. Workers.dev still exists but is secondary |

This means: **omitting the `routes` section is the workers.dev path.** We don't need to explicitly configure `workers.dev` — Cloudflare does it automatically.

### What changes in the generated TOML

**Before (current proxy `deploy.ts`):**
```toml
[routes]
routes = [{ pattern = "router.example.com", custom_domain = true }]
```
Always requires a domain. Breaks if user hasn't set one up.

**After (our orchestration script controls TOML generation):**
```toml
# ROUTER_DOMAIN not set — workers.dev mode (default)
# No routes section → Cloudflare assigns *.workers.dev
```
```toml
# ROUTER_DOMAIN=proxy.mydomain.com — custom domain mode (opt-in)
routes = [{ pattern = "proxy.mydomain.com", custom_domain = true }]
```

### How we control TOML generation

The proxy's `deploy.ts` `generateRouterToml()` always includes `routes`. We have two options:

**Option A (preferred): Modify `generateRouterToml()` to accept optional `routerDomain`.**
If `routerDomain` is null/empty, skip the `routes` section. This is a small, clean change to the proxy — a 5-line conditional. It maintains backward compat (passing a string still includes routes).

**Option B: Our orchestration script generates its own TOML.**
This duplicates `generateRouterToml()` logic and drifts from the proxy's deploy script. Invasive and fragile.

**We choose Option A.** This means one small proxy-side change: `generateRouterToml` gains an optional `routerDomain` parameter. If falsy, the `routes` key is omitted. This PR should be submitted upstream to `vadash/llm-proxy` as well — it's a universally useful improvement.

---

## D5: Auto-Endpoint Detection

### Primary: Parse wrangler deploy stdout

Wrangler prints on successful deploy:
```
Uploaded llm-proxy-router
Published llm-proxy-router (1.23 sec)
  https://llm-proxy-router.some-subdomain.workers.dev
```

Regex: `/https:\/\/[^\s]+\.workers\.dev/`

This is captured by the orchestration script because we spawn `deploy.ts` with `stdio: 'pipe'` (not `'inherit'`). We parse stdout, extract the URL, then replay stdout to the user's terminal (or just print our own summary).

### Fallback: Construct from account info

If the regex fails (wrangler output format changed), we fall back to:
1. `wrangler whoami --json` → parse `accounts[0].name`
2. Convert account name to subdomain slug: lowercase, replace non-alphanumeric with `-`, deduplicate `-`
3. Construct: `https://llm-proxy-router.<slug>.workers.dev`
4. Print: `⚠️ Router URL was constructed (not auto-detected). Verify it works.`

### Persist detected URL

Write `DETECTED_ROUTER_URL=<url>` to `freellmproxy/.env` if the key doesn't already exist. This is for downstream consumption (scripts, docs, gateway custom provider auto-wiring in future).

---

## D6: Deploy Script Invocation

The proxy's `scripts/deploy.ts` reads `.env` via `loadEnv()` and calls `wrangler deploy -c <config>`. We must ensure:

1. The `.env` file exists before `deploy.ts` runs (our orchestration handles this)
2. `ROUTER_DOMAIN` is passed correctly: if absent from `.env`, `deploy.ts` must not fail. Currently it calls `requireEnv("ROUTER_DOMAIN", 1)` which **exits 1**.

This is the one proxy code change we need: make `ROUTER_DOMAIN` optional in `deploy.ts`. If absent, `routerDomain` is `undefined`, and `generateRouterToml` receives it as `undefined`, producing TOML without routes.

**Change in `scripts/deploy.ts`:**
```typescript
// Before:
const routerDomain = requireEnv("ROUTER_DOMAIN", 1);

// After:
const routerDomain = process.env.ROUTER_DOMAIN || undefined;
// generateRouterToml already takes routerDomain param — we pass undefined
```

And in `generateRouterToml`:
```typescript
function generateRouterToml(proxyCount: number, internalSecret: string, authKey: string, routerDomain?: string): string {
  // ...
  const config: Record<string, unknown> = {
    name: "llm-proxy-router",
    // ...
    vars: { ... },
    services,
  };
  
  // Only add routes if domain is specified
  if (routerDomain) {
    config.routes = [{ pattern: routerDomain, custom_domain: true }];
  }
  
  return tomlStringify(config);
}
```

This is a **backward-compatible change**: if ROUTER_DOMAIN exists in .env, behavior is identical. If absent, the default switches to workers.dev.

---

## D7: `scripts/proxy-up.mjs` — Full Design

### Command dispatch

```
proxy-up.mjs <command>

Commands:
  up        Full pipeline: auth check → init → env → deploy → detect URL → print
  init      Submodule + deps only
  env       Bootstrap .env only
  dev       Wrangler dev
  status    Wrangler deployments list
  test      Proxy vitest
```

### Module structure

```
proxy-up.mjs
├── main()              — argv parse → dispatch
├── cmdUp()             — R3 full pipeline
│   ├── checkWrangler()
│   ├── ensureSubmodule()
│   ├── ensureDeps()
│   ├── bootstrapEnv()
│   ├── runDeploy()     — spawn deploy.ts, capture stdout
│   ├── extractUrl()   — regex parse or fallback
│   ├── persistUrl()   — append to .env if needed
│   └── printReady()    — the "READY" block
├── cmdInit()           — R2.2/R2.3 submodule + deps
├── cmdEnv()            — R4 bootstrap only
├── cmdDev()            — wrangler dev, stdio inherit
├── cmdStatus()         — wrangler deployments list, stdio inherit
├── cmdTest()           — npm test --prefix freellmproxy
├── helpers
│   ├── ROOT            — dirname(import.meta.url) → monorepo root
│   ├── PROXY_DIR      — path.join(ROOT, "freellmproxy")
│   ├── readEnv()       — parse .env file → Map
│   ├── writeEnv()      — append key=value to .env (idempotent)
│   ├── execAsync()     — promisified exec with cwd
│   ├── spawnAsync()    — promisified spawn with stdio control
│   ├── randomHex(n)    — crypto.randomBytes(n).toString('hex')
│   └── checkWrangler() — which wrangler + whoami → {ok, email?}
```

### Key implementation details

- **ROOT calculation**: Same pattern as `scripts/cli.mjs`:
  ```javascript
  const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
  ```
- **Env generation**: Use Node's `crypto` module. No external deps.
- **Deploy spawn**: `spawnAsync("npx", ["tsx", "scripts/deploy.ts"], { cwd: PROXY_DIR, stdio: ["ignore", "pipe", "pipe"] })`. Capture both stdout and stderr. Print them after parsing (or stream them live and tee to a buffer).
- **URL extraction**: After deploy exits 0, scan combined stdout+stderr for the regex. If found, that's the URL. If not, fallback to `wrangler whoami --json`.
- **Ready block**: Read AUTH_KEY from `.env` for the print. Include the full example URL.

---

## D8: Router TOML — Two Modes

### Default mode (workers.dev)

```toml
name = "llm-proxy-router"
main = "../src/worker.ts"
compatibility_date = "2024-12-01"
placement = { mode = "off" }

[vars]
WORKER_ROLE = "router"
AUTH_KEY = "a1b2c3d4e5f6a7b8"
INTERNAL_AUTH_SECRET = "64hex..."
PROXY_COUNT = "3"
ROUTER_DOMAIN = ""

[[services]]
binding = "PROXY_1"
service = "llm-proxy-01"

[[services]]
binding = "PROXY_2"
service = "llm-proxy-02"

[[services]]
binding = "PROXY_3"
service = "llm-proxy-03"
```

Note: no `routes` section. Cloudflare auto-assigns `workers.dev`.

### Custom domain mode (opt-in)

```toml
# Same as above, plus:
routes = [{ pattern = "proxy.mydomain.com", custom_domain = true }]
```

---

## D9: NPM Script Wiring

```jsonc
{
  "scripts": {
    // Existing (unchanged):
    "dev": "concurrently --kill-others-on-fail ...",
    "dev:lan": "concurrently ...",
    "build": "npm run build -w server && npm run build -w client",
    "build:server": "npm run build -w server",

    // Modified:
    "test": "npm run test -w server && npm run typecheck -w client && npm run proxy:test",

    // NEW:
    "postinstall": "node scripts/proxy-up.mjs init",
    "proxy:up": "node scripts/proxy-up.mjs up",
    "proxy:deploy": "node scripts/proxy-up.mjs up",     // alias
    "proxy:dev": "node scripts/proxy-up.mjs dev",
    "proxy:status": "node scripts/proxy-up.mjs status",
    "proxy:test": "node scripts/proxy-up.mjs test"
  }
}
```

### Why `postinstall` (not `prepare`)

Same reasoning as v1: `prepare` runs on `npm pack`. `postinstall` only on `npm install`. Our script installs a submodule's deps — we don't want that during `npm pack`.

---

## D10: CI Workflow

```yaml
- uses: actions/checkout@v4
  with:
    submodules: recursive

- run: npm install   # postinstall handles proxy deps
- run: npm test      # includes proxy:test
```

No deploy step. No wrangler auth in CI.

---

## D11: Gateway → Proxy Usage (Configuration Only)

After `proxy:up` prints the endpoint, the user wires it into the gateway as a custom provider:

1. Get the router URL and AUTH_KEY from the deploy output
2. Base64url-encode the target upstream: `node -e "console.log(Buffer.from('https://api.openai.com/v1').toString('base64url'))"`
3. Construct proxy URL: `https://<router-url>/<AUTH_KEY>/<PROXY_NUM>/<BASE64_URL>`
4. Dashboard → Add custom provider → Base URL = that proxy URL

No gateway code changes. The proxy is just another OpenAI-compatible endpoint from the gateway's perspective.

---

## D12: Proxy Code Changes Required

This is the complete list of proxy-side changes. All are backward-compatible.

| File | Change | Lines | Breaking? |
|------|--------|-------|-----------|
| `scripts/deploy.ts` → `requireEnv` | Make `ROUTER_DOMAIN` optional: `process.env.ROUTER_DOMAIN \|\| undefined` | ~1 line | No |
| `scripts/deploy.ts` → `generateRouterToml` | Accept optional `routerDomain`: if falsy, omit `routes` section. Also: if set, include `ROUTER_DOMAIN` in vars | ~5 lines | No |
| `scripts/deploy.ts` → `runWranglerDeploy` | Return `stdout` string in the result object (already does, just verify it's propagated) | 0 lines | No |

Total: ~6 lines changed in the proxy. No source code, no types, no tests need modification.

---

## D13: Rollback

Same as v1. Removing the submodule is clean. Deployed workers are unaffected.
