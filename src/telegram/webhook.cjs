const { webhookCallback } = require("grammy");
const { timingSafeEqual } = require("node:crypto");
function mountTelegramWebhook(app, bot, secret) {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret || ""))
    throw Error(
      "A private webhook secret of at least 32 characters is required.",
    );
  const callback = webhookCallback(bot, "express", {
    secretToken: secret,
    timeoutMilliseconds: 60000,
  });
  app.post("/api/telegram/webhook", (req, res, next) => {
    const provided = req.get("X-Telegram-Bot-Api-Secret-Token") || "";
    const a = Buffer.from(provided),
      b = Buffer.from(secret);
    if (a.length !== b.length || !timingSafeEqual(a, b))
      return res.sendStatus(401);
    if (
      !req.body ||
      !Number.isSafeInteger(req.body.update_id) ||
      req.body.update_id < 0
    )
      return res.sendStatus(400);
    Promise.resolve(callback(req, res, next)).catch(next);
  });
}
module.exports = { mountTelegramWebhook };
