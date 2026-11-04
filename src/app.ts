import { randomBytes } from "node:crypto";
import type { Api } from "grammy";
import { openDatabase } from "./db/db.ts";
import { createCatalog } from "./catalog/catalog.ts";
import { createMediFast } from "./domain/medifast.ts";
import { AREAS, seedDemo, STUDIO } from "./domain/seed.ts";
import { createBot } from "./telegram/bot.ts";
import { createNotifier } from "./telegram/notifier.ts";
import type { Links } from "./telegram/views.ts";
import { createFakeTelegram, STUDIO_BOT } from "./studio/fakeTelegram.ts";
import { createSimulator } from "./studio/simulator.ts";
import { createExtractor, type Extractor } from "./extract/extract.ts";
import type { Config } from "./config.ts";

export const PERSONAS = {
  customer: { id: 1001, first_name: "Aarav", ref: STUDIO.customer },
  pharmacist: { id: 1002, first_name: "Ravi", ref: STUDIO.pharmacist },
  admin: { id: 1003, first_name: "Admin", ref: STUDIO.admin },
} as const;
export type PersonaKey = keyof typeof PERSONAS;

/** Wires every layer together. The server and the tests both start here. */
export function createApp(config: Config, opts: { extract?: Extractor } = {}) {
  const db = openDatabase(config.databasePath);
  const catalog = createCatalog();
  const mf = createMediFast(db, catalog);
  const extract = opts.extract ?? createExtractor({ anthropicKey: config.anthropicKey });
  const secret = config.sessionSecret || randomBytes(32).toString("hex");

  const https = config.publicUrl.startsWith("https://");
  const links: Record<"live" | "studio", Links> = {
    live: {
      board: (id) => (https ? { url: `${config.publicUrl}/app/ask/${id}`, webApp: true } : null),
      desk: () => (https ? { url: `${config.publicUrl}/app/desk`, webApp: true } : null),
    },
    studio: {
      board: (id) => ({ url: `${config.baseUrl}/app/ask/${id}?as=customer`, webApp: false }),
      desk: () => ({ url: `${config.baseUrl}/app/desk?as=pharmacist`, webApp: false }),
    },
  };

  const apis: Partial<Record<"live" | "studio", Api>> = {};
  let studio: ReturnType<typeof makeStudio> | null = null;
  function makeStudio() {
    seedDemo(mf);
    const fake = createFakeTelegram();
    const bot = createBot({
      mf, transport: "studio", token: "studio", botInfo: STUDIO_BOT, areas: AREAS, links: links.studio,
      adminIds: new Set([String(PERSONAS.admin.id)]), extract,
      download: async (_api, fileId) => fake.file(fileId) ?? Promise.reject(new Error("file not found")),
    });
    fake.attach(bot.api);
    apis.studio = bot.api;
    return { fake, bot, input: fake.input(bot) };
  }
  if (config.demo.enabled) studio = makeStudio();

  let live: ReturnType<typeof createBot> | null = null;
  if (config.telegram.token && config.telegram.mode !== "off") {
    live = createBot({
      mf, transport: "live", token: config.telegram.token, areas: AREAS, links: links.live, adminIds: config.telegram.adminIds, extract,
      download: async (api, fileId) => {
        const file = await api.getFile(fileId);
        const res = await fetch(`https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`);
        if (!res.ok) throw new Error(`download failed: ${res.status}`);
        const mime = /\.png$/i.test(file.file_path ?? "") ? "image/png" : "image/jpeg";
        return { data: Buffer.from(await res.arrayBuffer()), mime };
      },
    });
    apis.live = live.api;
  }

  const sim = config.demo.enabled ? createSimulator(mf, { speed: config.demo.speed }) : undefined;
  const notifier = createNotifier(mf, { apis, links, sim });
  const tick = setInterval(() => mf.tick(), 15_000);
  tick.unref();

  return {
    config, db, mf, catalog, studio, live, links, secret, notifier,
    stop() { clearInterval(tick); sim?.stop(); db.close(); },
  };
}
export type App = ReturnType<typeof createApp>;
