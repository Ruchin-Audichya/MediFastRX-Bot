#!/usr/bin/env node
// MediFast one-click demo launcher.
// Plain JavaScript on purpose, so it can explain the problem even on an old Node.js.
//
// What it does: check Node.js → install dependencies (first run) → build the web app
// (first run) → start MediFast on a free port with a fresh demo database → open Demo Studio.
// Close this window (or press Ctrl+C) to stop.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIN = process.platform === "win32";
const args = new Set(process.argv.slice(2));
const say = (msg = "") => console.log(msg);
const fail = (msg) => {
  say(`\n  ✖ ${msg}\n`);
  if (WIN) spawnSync("cmd", ["/c", "pause"], { stdio: "inherit" });
  process.exit(1);
};

say("\n  ┌──────────────────────────────────────────┐");
say("  │   MediFast · ask every chemist nearby    │");
say("  │   Demo launcher                          │");
say("  └──────────────────────────────────────────┘\n");

// 1. Node.js version (node:sqlite and TypeScript type stripping need 22.18+).
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  fail(`Node.js ${process.versions.node} is too old. Install Node.js 24 LTS from https://nodejs.org and run this again.`);
}
say(`  ✔ Node.js ${process.versions.node}`);

// 2. Dependencies and web build, only when missing (first run, or after an update).
const npm = (cmdArgs, label) => {
  say(`  … ${label} (first run only, takes a minute)`);
  const r = spawnSync(WIN ? "npm.cmd" : "npm", cmdArgs, { cwd: ROOT, stdio: "inherit", shell: WIN });
  if (r.status !== 0) fail(`${label} failed. Check your internet connection and try again.`);
};
if (!existsSync(join(ROOT, "node_modules", "grammy")) || args.has("--reinstall")) npm(["ci", "--no-audit", "--no-fund"], "Installing dependencies");
say("  ✔ Dependencies ready");
if (!existsSync(join(ROOT, "web", "dist", "index.html")) || args.has("--rebuild")) npm(["run", "build"], "Building the web app");
say("  ✔ Web app ready");

// 3. Optional .env (a Telegram bot token makes the real bot run alongside the demo).
const env = { ...process.env };
const envFile = join(ROOT, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[2] && !(m[1] in process.env)) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

// 4. Fresh demo database each launch (pass --keep to keep the previous demo's data).
const db = join(ROOT, "var", "demo.db");
mkdirSync(dirname(db), { recursive: true });
if (!args.has("--keep")) for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });

// 5. A free port, starting at 3000.
const free = (port) => new Promise((ok) => {
  const s = createServer().once("error", () => ok(false)).once("listening", () => s.close(() => ok(true)));
  s.listen(port);
});
let port = Number(env.PORT) || 3000;
while (!(await free(port))) port++;
const url = `http://localhost:${port}`;

// 6. Start the server.
Object.assign(env, {
  PORT: String(port),
  DATABASE_PATH: db,
  DEMO_MODE: "true",
  DEMO_SPEED: env.DEMO_SPEED || "0.5", // simulated pharmacies answer within ~5–30 s
  PUBLIC_URL: env.PUBLIC_URL || "",
});
say("  … Starting MediFast");
const server = spawn(process.execPath, ["src/main.ts"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
server.stdout.on("data", (d) => process.stdout.write(`    ${d}`.replace(/\n(?=.)/g, "\n    ")));
server.stderr.on("data", (d) => process.stderr.write(`    ${d}`.replace(/\n(?=.)/g, "\n    ")));
server.on("exit", (code) => fail(`MediFast stopped (exit code ${code}). Scroll up for the error.`));
const stop = () => { server.removeAllListeners("exit"); server.kill(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("SIGHUP", stop);

// 7. Wait until healthy, then open the browser.
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`${url}/healthz`)).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
  if (i === 59) fail("MediFast did not start within 30 seconds.");
}
const studio = `${url}/studio`;
say(`\n  ✔ MediFast is running\n`);
say(`    Demo Studio   ${studio}`);
say(`    Website       ${url}`);
say(`    Pharmacy desk ${url}/app/desk?as=pharmacist\n`);
say("  Keep this window open during the demo. Close it (or press Ctrl+C) to stop.\n");
if (!args.has("--no-browser") && !env.MEDIFAST_NO_BROWSER) {
  const open = WIN ? ["cmd", ["/c", "start", "", studio]] : process.platform === "darwin" ? ["open", [studio]] : ["xdg-open", [studio]];
  spawn(open[0], open[1], { stdio: "ignore", detached: true }).on("error", () => say(`  Open ${studio} in your browser.`)).unref();
}
