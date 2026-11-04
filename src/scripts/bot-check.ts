// npm run bot:check — verifies TELEGRAM_BOT_TOKEN (from the environment or .env) without starting the bot.
import { existsSync, readFileSync } from "node:fs";

if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[2] && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
const fail = (msg: string): never => { console.error(`✖ ${msg}`); process.exit(1); };
if (!token) fail("TELEGRAM_BOT_TOKEN is not set. Put it in .env (see .env.example).");
if (!/^\d+:[\w-]{30,}$/.test(token)) fail("That doesn't look like a BotFather token (expected 123456789:ABC…).");

const call = async (method: string) => {
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/${method}`);
  } catch (e: any) {
    return fail(`Couldn't reach api.telegram.org (${e?.cause?.code ?? e?.message}). Check your internet connection.`);
  }
  const body = (await res.json()) as { ok: boolean; result?: any; description?: string };
  if (!body.ok) fail(`${method}: ${body.description ?? res.status}`);
  return body.result;
};
const me = await call("getMe");
const hook = await call("getWebhookInfo");
console.log(`✔ Token works: @${me.username} (${me.first_name}), id ${me.id}`);
console.log(`  Webhook: ${hook.url ? hook.url : "none (long polling will be used)"}${hook.last_error_message ? ` · last error: ${hook.last_error_message}` : ""}`);
const admins = (process.env.ADMIN_TELEGRAM_IDS ?? "").split(",").filter(Boolean);
console.log(admins.length ? `  Admins: ${admins.join(", ")}` : "  ⚠ ADMIN_TELEGRAM_IDS is empty: nobody can approve pharmacies. Add your numeric id (ask @userinfobot).");
const url = process.env.PUBLIC_URL ?? "";
console.log(url.startsWith("https://") ? `  Public URL: ${url} (webhook + Mini App enabled)` : "  PUBLIC_URL not https: fine locally; the Mini App needs an https deployment.");
