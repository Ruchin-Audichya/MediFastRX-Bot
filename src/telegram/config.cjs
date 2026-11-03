class TelegramConfigError extends Error {}
function telegramConfig(env = process.env, { requireToken = true } = {}) {
  const token = env.TELEGRAM_BOT_TOKEN || env.BOT_TOKEN || "";
  if (requireToken && !/^\d+:[\w-]{20,}$/.test(token))
    throw new TelegramConfigError(
      "Set TELEGRAM_BOT_TOKEN in an untracked .env file. Get it from @BotFather; never commit or log it.",
    );
  const mode = env.TELEGRAM_MODE || "polling";
  if (!["polling", "webhook"].includes(mode))
    throw new TelegramConfigError("TELEGRAM_MODE must be polling or webhook.");
  const secret = env.TELEGRAM_WEBHOOK_SECRET || "";
  if (mode === "webhook" && !/^[A-Za-z0-9_-]{32,256}$/.test(secret))
    throw new TelegramConfigError(
      "Webhook mode needs a private TELEGRAM_WEBHOOK_SECRET (32–256 letters, digits, underscores or hyphens).",
    );
  const webUrl = env.TELEGRAM_APP_URL || "";
  if (webUrl) {
    let valid = false;
    try {
      const u = new URL(webUrl);
      valid =
        u.protocol === "https:" &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash;
    } catch {}
    if (!valid)
      throw new TelegramConfigError(
        "TELEGRAM_APP_URL must be a public HTTPS app URL without credentials, query or fragment.",
      );
  }
  return { token, mode, secret, webUrl };
}
module.exports = { telegramConfig, TelegramConfigError };
