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
    sessionSecret: e.SESSION_SECRET ?? "",
  };
}
