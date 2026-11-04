// npm run dev — API with auto-restart + Vite dev server, cross-platform (no shell "&").
import { spawn } from "node:child_process";
const win = process.platform === "win32";
const procs = [
  spawn(process.execPath, ["--watch-path=src", "src/main.ts"], { stdio: "inherit" }),
  spawn(win ? "npx.cmd" : "npx", ["vite", "--config", "web/vite.config.ts"], { stdio: "inherit", shell: win }),
];
const stop = () => { procs.forEach((p) => p.kill()); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
procs.forEach((p) => p.on("exit", (code) => { if (code) { console.error(`A dev process exited with code ${code}`); stop(); } }));
