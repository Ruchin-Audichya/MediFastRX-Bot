require("dotenv").config({ quiet: true });
const { spawn } = require("node:child_process");
const path = require("node:path"),
  fs = require("node:fs");
const local = path.resolve(".local/node-v24.22.0-linux-x64/bin/node");
const runtime =
  Number(process.versions.node.split(".")[0]) === 24
    ? process.execPath
    : fs.existsSync(local)
      ? local
      : null;
if (!runtime) {
  console.error("Use Node 24: nvm install && nvm use");
  process.exit(1);
}
const production = process.argv.includes("--production");
const withTelegram = process.argv.includes("--telegram");
if (withTelegram) {
  try {
    const config = require("../src/telegram/config.cjs").telegramConfig();
    if (config.mode !== "polling")
      throw Error(
        "Use npm run dev for webhook mode; the API receives Telegram updates.",
      );
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
const children = [];
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const p of children) p.kill("SIGTERM");
};
const processes = [
  ["src/server.cjs", []],
  [
    "node_modules/next/dist/bin/next",
    [
      production ? "start" : "dev",
      "-H",
      "127.0.0.1",
      "-p",
      process.env.WEB_PORT || "3000",
    ],
  ],
];
if (withTelegram) processes.push(["src/telegram/run.cjs", []]);
for (const [file, args] of processes) {
  const p = spawn(
    runtime,
    [
      ...(!production && file === "src/server.cjs" ? ["--watch"] : []),
      path.resolve(file),
      ...args,
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_ENV: production ? "production" : "development",
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  );
  children.push(p);
  p.on("exit", (code) => {
    stop();
    process.exitCode = code || 0;
  });
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
