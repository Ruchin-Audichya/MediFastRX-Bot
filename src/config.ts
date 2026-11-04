const env = process.env;
const list = (v?: string) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(over: Partial<Record<string, string>> = {}) {
  const e = { ...env, ...over };
  const publicUrl = (e.PUBLIC_URL ?? "").replace(/\/$/, "");
  const port = Number(e.PORT ?? 3000);
  return {
    port,
    publicUrl,
    baseUrl: publicUrl || `http://localhost:${port}`,
    databasePath: e.DATABASE_PATH ?? "var/medifast.db",
    telegram: {
      token: e.TELEGRAM_BOT_TOKEN ?? "",
      // auto: webhook when PUBLIC_URL is https, long polling otherwise
      mode: (e.TELEGRAM_MODE ?? "auto") as "auto" | "polling" | "webhook" | "off",
      webhookSecret: e.TELEGRAM_WEBHOOK_SECRET ?? "",
      adminIds: new Set(list(e.ADMIN_TELEGRAM_IDS)),
    },
    demo: {
      enabled: (e.DEMO_MODE ?? "true") !== "false",
      speed: Number(e.DEMO_SPEED ?? 1),
      // When set, Demo Studio and its personas need this password (set it on any public deployment).
      studioPassword: e.STUDIO_PASSWORD ?? "",
    },
    anthropicKey: e.ANTHROPIC_API_KEY ?? "",
    // Pincode geocoding (OSM Nominatim) and nearby-pharmacy listings (OSM Overpass). Both are free,
    // keyless and cached; set EXTERNAL_LOOKUPS=false for fully offline runs.
    externalLookups: (e.EXTERNAL_LOOKUPS ?? "true") !== "false",
    // Disclosed affiliate parameters for online-pharmacy links, e.g. AFFILIATE_1MG="utm_source=medifast".
    affiliates: Object.fromEntries(Object.entries(e).filter(([k, v]) => k.startsWith("AFFILIATE_") && v).map(([k, v]) => [k.slice(10).toLowerCase(), String(v)])),
    // Map tiles: OpenStreetMap data needs no key. Set MAP_TILE_URL only to use a keyed provider (MapTiler, Stadia…).
    map: {
      tileUrl: e.MAP_TILE_URL || "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      attribution: e.MAP_ATTRIBUTION || '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>',
    },
    botUsername: e.BOT_USERNAME ?? "",
    sessionSecret: e.SESSION_SECRET ?? "",
  };
}
