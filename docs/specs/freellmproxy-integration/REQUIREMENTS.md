# Requirements — FreeLLMProxy Submodule Integration (v2 — Todd Howard Edition)

---

## R1: Git Submodule Structure

**R1.1** The proxy repository (`https://github.com/animaios/freeproxy`) shall be added as a git submodule at path `freellmproxy/` within the monorepo root.

**R1.2** The submodule shall point to the `main` branch. `.gitmodules` shall include `branch = main`.

**R1.3** The submodule URL shall use `https://` form (not `git@`) so anonymous `git clone --recursive` works without SSH keys.

---

## R2: Zero-Setup Post-Clone

**R2.1** After `git clone --recurse-submodules`, `freellmproxy/` contains the full source tree — no manual steps.

**R2.2** Running `npm install` from the monorepo root shall also install dependencies in `freellmproxy/`.

**R2.3** If a user clones without `--recurse-submodules` and then runs `npm install`, the postinstall script shall detect the missing submodule, auto-initialize it, and proceed. No user intervention needed.

**R2.4** `wrangler` is the **only** external prerequisite. If missing, any proxy script prints: `⚠️ wrangler not found. Install: npm i -g wrangler && wrangler login` and exits non-zero.

---

## R3: One-Command Full Deploy — `proxy:up`

**R3.1** `npm run proxy:up` from the monorepo root shall:
1. Verify `wrangler` is on `$PATH`
2. Verify wrangler auth (`wrangler whoami` exits 0)
3. Ensure the submodule is initialized and up to date
4. Ensure `freellmproxy/node_modules` exists
5. Generate `freellmproxy/.env` if missing (see R4)
6. Deploy all proxy workers + router
7. Auto-detect the router endpoint URL from deploy output (see R5)
8. Print the working endpoint URL

**R3.2** The command exits 0 on full success, non-zero on any failure.

**R3.3** If any proxy worker fails, remaining workers and the router shall still be attempted (don't abort early).

**R3.4** `npm run proxy:deploy` is an alias for `proxy:up` (backward compat).

---

## R4: Fully Automatic Environment Bootstrap

**R4.1** If `freellmproxy/.env` does not exist, it shall be generated with:
- `AUTH_KEY` — `crypto.randomBytes(16).toString('hex').slice(0, 16)` (16 hex chars, 8 bytes of entropy)
- `INTERNAL_AUTH_SECRET` — `crypto.randomBytes(32).toString('hex')` (64 hex chars)
- `PROXY_COUNT` — `3`

**R4.2** `ROUTER_DOMAIN` shall **NOT** be written to `.env` by default. If `ROUTER_DOMAIN` is absent from `.env`, the router TOML shall be generated **without a `routes` section** (see R5.2). This activates the `workers.dev` subdomain automatically.

**R4.3** If the user manually adds `ROUTER_DOMAIN=some.domain.com` to `freellmproxy/.env`, the router TOML shall include `routes = [{ pattern = "some.domain.com", custom_domain = true }]`. This is the optional custom-domain path.

**R4.4** Existing values in `.env` are **never overwritten**. Idempotent: running `proxy:up` twice changes nothing on the second run.

**R4.5** Secrets shall not be derived from the gateway's `ENCRYPTION_KEY`. Each system generates its own secrets. The proxy and gateway have different trust boundaries.

---

## R5: Workers.dev-First Router Deployment

**R5.1** When `ROUTER_DOMAIN` is **not** set in `.env`:
- The generated router TOML shall have **no `routes` section**
- Cloudflare automatically assigns: `https://llm-proxy-router.<account-subdomain>.workers.dev`
- The worker name is always `llm-proxy-router` — this is stable and known

**R5.2** When `ROUTER_DOMAIN` **is** set in `.env`:
- The generated router TOML includes: `routes = [{ pattern = "<ROUTER_DOMAIN>", custom_domain = true }]`
- This overrides `workers.dev` with the custom domain

**R5.3** After router deploy, the orchestration script shall parse wrangler's stdout for the published URL. Wrangler's deploy output includes a line like:
```
Published llm-proxy-router (x.xx sec)
  https://llm-proxy-router.<subdomain>.workers.dev
```
The script extracts this URL and prints it as the usable endpoint.

**R5.4** If URL extraction from stdout fails (e.g., output format changed), the script shall fall back to `wrangler whoami --json` to get the account ID and construct: `https://llm-proxy-router.<account-name-slug>.workers.dev`. A warning shall be printed that the URL was constructed rather than detected.

**R5.5** The detected or constructed URL shall be written to `freellmproxy/.env` as `DETECTED_ROUTER_URL` **only if** that key does not already exist (idempotent, never overwrites). This allows downstream tooling to read it.

---

## R6: Deploy Output — The "It Just Works" Print

**R6.1** On successful deploy, `proxy:up` shall print:

```
🚀 READY

Router URL:  https://llm-proxy-router.<subdomain>.workers.dev
Auth key:    <AUTH_KEY>

Example request:
POST https://llm-proxy-router.<subdomain>.workers.dev/<AUTH_KEY>/1/<BASE64_URL>
```

**R6.2** The AUTH_KEY printed shall be the actual key from `.env`, not a placeholder. The user copies this and uses it.

**R6.3** No mention of "edit ROUTER_DOMAIN" or "go to Cloudflare dashboard" shall appear in the default output. Those are advanced paths documented in the README, not in the deploy output.

---

## R7: Wrangler Auth Check

**R7.1** Before any deploy, the script shall run `wrangler whoami` and verify it exits 0 (logged in).

**R7.2** If wrangler is on PATH but not logged in, the script shall print:
```
⚠️ wrangler is installed but not logged in. Run: wrangler login
```
and exit 1.

**R7.3** The script shall **not** attempt to run `wrangler login` on the user's behalf — that opens a browser and is interactive. The user must do it themselves (one-time setup).

---

## R8: NPM Script Surface

**R8.1** The monorepo root `package.json` shall gain:
- `proxy:up` — full deploy pipeline (R3). Alias: `proxy:deploy`
- `proxy:dev` — `wrangler dev` in the proxy submodule
- `proxy:status` — list deployed workers via wrangler
- `proxy:test` — run proxy vitest suite

**R8.2** `proxy:test` shall be included in the top-level `npm test` chain.

**R8.3** All scripts handle `freellmproxy/` being absent — log warning, exit 0 for optional scripts, exit 1 for `proxy:up`.

---

## R9: Monorepo Install Integration

**R9.1** Root `package.json` `postinstall` shall auto-init submodule and install proxy deps (R2.2, R2.3).

**R9.2** The postinstall script is idempotent — multiple runs have no side effects.

**R9.3** If the submodule directory is missing (non-interactive CI, shallow clone), log a warning and continue. Don't block the gateway install.

---

## R10: CI Integration

**R10.1** CI checkout uses `submodules: recursive`. CI runs `npm test` which includes `proxy:test`.

**R10.2** CI **never** deploys the proxy. Deployment is manual only.

---

## R11: Preserved Proxy Independence

**R11.1** The proxy remains fully functional standalone: `cd freellmproxy && npm run deploy` still works.

**R11.2** All proxy source files (`package.json`, `wrangler.toml`, `tsconfig.json`, `.env.example`, etc.) remain **unchanged**. Integration logic lives entirely in the monorepo's `scripts/` and `package.json`.

**R11.3** Upstream tracking continues: `cd freellmproxy && git fetch upstream && git merge upstream/main` produces clean merges.

---

## R12: Documentation

**R12.1** README gains a "Cloud Proxy" section explaining:
- What it does (IP rotation, header stripping, deterministic fake IPs)
- The command: `npm run proxy:up`
- Prerequisites: wrangler + logged in
- The optional custom-domain path: add `ROUTER_DOMAIN` to `freellmproxy/.env`

**R12.2** No documentation shall frame custom domains as required. They are presented as optional enhancements.

---

## R13: Rollback Safety

**R13.1** Removing the submodule is clean:
```bash
git submodule deinit -f freellmproxy
git rm -f freellmproxy
rm -rf .git/modules/freellmproxy
# Remove proxy:* scripts from package.json
```
The monorepo works identically before and after.

**R13.2** Deployed Cloudflare Workers are unaffected by submodule removal. Redeploying after re-adding restores everything.

**R13.3** All monorepo scripts referencing `freellmproxy/` handle its absence gracefully.

---

## Removed from v1

These v1 requirements are **deleted** in v2:

| Removed | Why |
|---------|-----|
| `ROUTER_DOMAIN` as required env var | Workers.dev makes it unnecessary for default use |
| "Edit ROUTER_DOMAIN before deploying to production" | Default deploy works without it. Custom domain is opt-in |
| AUTH_KEY derived from gateway's ENCRYPTION_KEY | Separate trust boundaries. Auto-generate independently |
| "configure custom domain in Cloudflare dashboard" | Not needed for workers.dev. Dashboard is power-user territory |
