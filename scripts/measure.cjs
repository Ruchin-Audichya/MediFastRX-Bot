const { spawn } = require("node:child_process");
const fs = require("node:fs");
const start = performance.now();
const child = spawn(process.execPath, ["src/server.cjs"], {
  env: { ...process.env, API_PORT: "3002", PHARMACY_MODE: "demo", APP_MODE: "demo", CATALOG_FILE: ":memory:" },
  stdio: ["ignore", "pipe", "pipe"],
});
const output = [];
child.stderr.on("data", () => {});
const stop = () => child.kill("SIGTERM");
process.on("exit", stop);
(async () => {
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Startup timeout")), 10000);
      child.stdout.on("data", (b) => {
        output.push(b.toString());
        if (b.toString().includes("API ready")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on("exit", (c) => {
        clearTimeout(timer);
        reject(Error(`Server exited ${c}`));
      });
    });
    const startupMs = performance.now() - start;
    async function measure(path, options, n) {
      const samples = [];
      for (let i = 0; i < n; i++) {
        const t = performance.now();
        const r = await fetch("http://127.0.0.1:3002" + path, options);
        if (!r.ok) throw Error(`HTTP ${r.status}`);
        await r.json();
        samples.push(performance.now() - t);
      }
      const sorted = [...samples].sort((a, b) => a - b);
      return {
        requests: n,
        firstMs: +samples[0].toFixed(2),
        medianMs: +sorted[Math.floor(n / 2)].toFixed(2),
        p95Ms: +sorted[Math.ceil(n * 0.95) - 1].toFixed(2),
      };
    }
    const report = {
      runtime: process.version,
      environment:
        "Local SQLite demo, loopback HTTP, no LLM or external network. Fresh server process with newly seeded in-memory demo DB. Sequential requests.",
      startupMs: +startupMs.toFixed(2),
      startupLog: output.join("").trim(),
      lookup: await measure(
        "/api/message",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: "Dolo 650" }),
        },
        40,
      ),
      pharmacies: await measure("/api/pharmacies?area=Jaipur", {}, 20),
    };
    fs.writeFileSync(
      "docs/evidence/performance.json",
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(JSON.stringify(report, null, 2));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    stop();
  }
})();
