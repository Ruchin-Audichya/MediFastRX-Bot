require("dotenv").config({ quiet: true });
const { openCatalog } = require("../src/medicine/catalog.cjs");
const { createPlatform, passwordHash } = require("../src/platform/core.cjs");
const crypto = require("node:crypto");
const catalog = openCatalog();
const p = createPlatform(catalog, { seed: false });
if (process.argv.includes("--reset")) {
  if (p.mode !== "demo") throw Error("Reset is disabled in live mode.");
  const files = p.db.prepare("SELECT path FROM prescriptions").all();
  p.seedDemo(true);
  for (const file of files) {
    try {
      require("node:fs").unlinkSync(file.path);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  console.log("Demo database reset. Restart the app.");
} else if (p.mode === "demo") {
  p.seedDemo();
  console.log(
    "Demo customer, pharmacy and admin are ready. Password: DemoPass!2026",
  );
} else {
  const email = process.env.ADMIN_EMAIL,
    password = process.env.ADMIN_PASSWORD;
  if (!email || !password || password.length < 16)
    throw Error(
      "Set ADMIN_EMAIL and ADMIN_PASSWORD (16+ characters) for initial admin creation.",
    );
  p.db
    .prepare(
      "INSERT INTO users(id,email,name,password,role) VALUES (?,?,?,?,?)",
    )
    .run(
      crypto.randomUUID(),
      email.toLowerCase(),
      "Administrator",
      passwordHash(password),
      "admin",
    );
  console.log("Administrator created. No credentials printed.");
}
catalog.close();
