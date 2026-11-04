// npm run seed:reset — deletes the local database so the next start re-creates the fictional demo network.
// Only touches DATABASE_PATH (default var/medifast.db). Refuses to run when PUBLIC_URL is set, to protect live data.
import { existsSync, rmSync } from "node:fs";

const db = process.env.DATABASE_PATH ?? "var/medifast.db";
if (process.env.PUBLIC_URL && !process.argv.includes("--force")) {
  console.error("✖ PUBLIC_URL is set, so this looks like a live deployment. Re-run with --force if you really want to wipe it.");
  process.exit(1);
}
let removed = 0;
for (const f of [db, `${db}-wal`, `${db}-shm`]) if (existsSync(f)) { rmSync(f); removed++; }
console.log(removed ? `✔ Removed ${db}. Start MediFast again to re-create the demo network.` : `Nothing to remove (${db} does not exist).`);
