#!/usr/bin/env node
/**
 * proxy-up.mjs — Orchestration script for the freellmproxy git submodule.
 *
 * Commands:
 *   init     Auto-init submodule if missing, install proxy deps
 *   env      Bootstrap freellmproxy/.env if missing
 *   test     Run proxy vitest suite
 *   dev      Run wrangler dev (local dev server, blocks until Ctrl-C)
 *   up       Full deploy pipeline: check auth → init → env → deploy → persist URL
 *   status   Show deployed worker status
 *
 * Design principles:
 *   - Idempotent: running twice is a no-op
 *   - Non-fatal: if the submodule is absent, log a warning and exit 0
 *     (except for dev which exits 1 — explicit user action)
 *   - No interactive prompts: everything is automated
 */
import { execSync, spawn } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROXY_DIR = join(ROOT, "freellmproxy");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dirExists(p) {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * readEnvFile — Parse a .env file into a Map<string, string>.
 * Skips blank lines and comments (#). Only captures KEY=Value lines.
 */
function readEnvFile(filePath) {
  const map = new Map();
  if (!existsSync(filePath)) return map;
  const content = readFileSync(filePath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    map.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return map;
}

/**
 * checkWrangler — Verify wrangler is installed and logged in.
 * Exits with error message on failure, returns whoami JSON on success.
 */
function checkWrangler() {
  let whoamiJson;
  try {
    whoamiJson = execSync("wrangler whoami --json", { encoding: "utf-8" });
  } catch (err) {
    if (err.code === "ENOENT") {
      console.log(
        "⚠️  wrangler not found. Install: npm i -g wrangler && wrangler login",
      );
      process.exit(1);
    }
    console.log("⚠️  wrangler not logged in. Run: wrangler login");
    process.exit(1);
  }

  let whoami;
  try {
    whoami = JSON.parse(whoamiJson);
  } catch {
    console.log("⚠️  wrangler not logged in. Run: wrangler login");
    process.exit(1);
  }

  if (!whoami.loggedIn) {
    console.log("⚠️  wrangler not logged in. Run: wrangler login");
    process.exit(1);
  }

  return whoami;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/**
 * init — Ensure the freellmproxy submodule is populated and deps installed.
 * Idempotent and non-fatal on missing submodule.
 */
function cmdInit() {
  if (!dirExists(PROXY_DIR)) {
    // Submodule directory doesn't exist — try to init from git modules
    if (dirExists(join(ROOT, ".git", "modules", "freellmproxy"))) {
      console.log("🔧 Initializing freellmproxy submodule...");
      execSync("git submodule update --init --recursive", {
        cwd: ROOT,
        stdio: "inherit",
      });
    } else {
      console.log("⚠️  freellmproxy submodule not available. Skipping.");
      process.exit(0);
    }
  }

  // At this point PROXY_DIR should exist — ensure deps are installed
  if (!dirExists(join(PROXY_DIR, "node_modules"))) {
    console.log("📦 Installing proxy dependencies...");
    execSync("npm install --prefix freellmproxy", {
      cwd: ROOT,
      stdio: "inherit",
    });
    console.log("✅ Proxy dependencies installed.");
  }
}

/**
 * env — Bootstrap freellmproxy/.env if it doesn't exist.
 * Never overwrites an existing .env.
 */
function cmdEnv() {
  const envPath = join(PROXY_DIR, ".env");

  if (existsSync(envPath)) {
    // Already exists — never overwrite
    return;
  }

  // Generate secrets
  const authKey = randomBytes(16).toString("hex").slice(0, 16);
  const internalAuthSecret = randomBytes(32).toString("hex");

  const envContent =
    [
      `AUTH_KEY=${authKey}`,
      `INTERNAL_AUTH_SECRET=${internalAuthSecret}`,
      `PROXY_COUNT=3`,
    ].join("\n") + "\n";

  writeFileSync(envPath, envContent, "utf-8");
  console.log("✅ Generated freellmproxy/.env");
}

/**
 * test — Run the proxy's test suite.
 * Gracefully exits 0 if the submodule is absent.
 */
function cmdTest() {
  if (!dirExists(PROXY_DIR)) {
    console.log("⚠️  freellmproxy not available, skipping proxy tests.");
    process.exit(0);
  }

  execSync("npm test --prefix freellmproxy", { cwd: ROOT, stdio: "inherit" });
}

/**
 * dev — Run wrangler dev in the proxy directory.
 * Blocks until Ctrl-C. Exits 1 if submodule is absent.
 */
function cmdDev() {
  if (!dirExists(PROXY_DIR)) {
    console.error(
      "❌ freellmproxy/ not found. Clone with --recurse-submodules first.",
    );
    process.exit(1);
  }

  const child = spawn("npx", ["wrangler", "dev"], {
    cwd: PROXY_DIR,
    stdio: "inherit",
  });

  child.on("close", (code) => {
    process.exit(code ?? 1);
  });

  child.on("error", (err) => {
    console.error("❌ Failed to start wrangler dev:", err.message);
    process.exit(1);
  });
}

/**
 * up — Full deploy pipeline:
 *   1. Check wrangler auth
 *   2. init + env (idempotent)
 *   3. Deploy via proxy's deploy.ts
 *   4. Extract endpoint URL
 *   5. Persist detected URL to .env
 *   6. Print ready block
 */
function cmdUp() {
  // Step 1 — Wrangler check
  const whoami = checkWrangler();
  const email = whoami?.auth_status?.email;
  if (email) console.log(`✅ Wrangler authenticated as ${email}`);

  // Step 2 — Init + Env (idempotent)
  cmdInit();
  cmdEnv();

  // Step 3 — Deploy
  console.log("🚀 Deploying proxy workers...");
  const deployChild = spawn("npx", ["tsx", "scripts/deploy.ts"], {
    cwd: PROXY_DIR,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  deployChild.stdout.on("data", (chunk) => {
    const str = chunk.toString();
    stdout += str;
    process.stdout.write(str);
  });

  deployChild.stderr.on("data", (chunk) => {
    const str = chunk.toString();
    stderr += str;
    process.stderr.write(str);
  });

  deployChild.on("close", (code) => {
    if (code !== 0) {
      console.error(`❌ Deploy failed (exit ${code})`);
      if (stderr) console.error(stderr.trim());
      process.exit(code ?? 1);
    }

    // Step 4 — Extract endpoint URL
    let routerUrl;
    const urlMatch = stdout.match(/https:\/\/[^\s"']+\.workers\.dev/);
    if (urlMatch) {
      routerUrl = urlMatch[0];
    } else {
      // Fallback: construct URL from account name
      const fallbackWhoami = checkWrangler();
      const accountName =
        fallbackWhoami?.accounts?.[0]?.name ||
        fallbackWhoami?.account?.name ||
        "";
      if (!accountName) {
        console.error(
          "❌ Could not determine account name for URL construction.",
        );
        process.exit(1);
      }
      const slug = accountName
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
      routerUrl = `https://llm-proxy-router.${slug}.workers.dev`;
      console.log(
        "⚠️  Router URL was constructed (not auto-detected). Verify it works.",
      );
    }

    // Step 5 — Persist detected URL
    const envPath = join(PROXY_DIR, ".env");
    const envMap = readEnvFile(envPath);
    if (!envMap.has("DETECTED_ROUTER_URL")) {
      appendFileSync(envPath, `\nDETECTED_ROUTER_URL=${routerUrl}\n`, "utf-8");
      console.log("✅ Persisted DETECTED_ROUTER_URL to .env");
    } else {
      console.log("ℹ️  DETECTED_ROUTER_URL already in .env, not overwriting.");
    }

    // Step 6 — Print ready block
    const authKey = envMap.get("AUTH_KEY") || "<AUTH_KEY not found>";

    console.log(`
🚀 READY

Router URL:  ${routerUrl}
Auth key:    ${authKey}

Example request:
POST ${routerUrl}/${authKey}/1/<BASE64_URL>
`);
  });

  deployChild.on("error", (err) => {
    console.error("❌ Failed to start deploy:", err.message);
    process.exit(1);
  });
}

/**
 * status — Show deployed worker status.
 */
function cmdStatus() {
  checkWrangler();
  try {
    execSync("npx wrangler deployments list", {
      cwd: PROXY_DIR,
      stdio: "inherit",
    });
  } catch (err) {
    process.exit(err.status ?? 1);
  }
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

const command = process.argv[2];

const commands = {
  init: cmdInit,
  env: cmdEnv,
  test: cmdTest,
  dev: cmdDev,
  up: cmdUp,
  status: cmdStatus,
};

if (!command || !commands[command]) {
  console.log(`
proxy-up.mjs <command>

Commands:
  init        Auto-init submodule if missing, install deps
  env         Bootstrap freellmproxy/.env if missing
  test        Run proxy vitest suite
  dev         Run wrangler dev (local dev server)
  up          Deploy proxy workers (wrangler check → init → env → deploy → persist URL)
  status      Show deployed worker status
`);
  process.exit(command ? 1 : 0);
}

commands[command]();
