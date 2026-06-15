"use strict";

// WhatsApp Cloud API client (Meta Graph API). Sends text and location-request
// messages. Mock-friendly: when WHATSAPP_ENABLED is not "true" or the token is
// missing, send() logs and returns a synthetic ok so local/dev/demo flows work
// without real Meta credentials.

const logger = require("../../utils/logger");

const cfg = () => ({
  enabled: String(process.env.WHATSAPP_ENABLED || "false").toLowerCase() === "true",
  token: process.env.WHATSAPP_TOKEN || "",
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
  apiVersion: process.env.WHATSAPP_API_VERSION || "v21.0",
  timeoutMs: Number(process.env.WHATSAPP_TIMEOUT_MS || 5000),
});

const isLive = () => {
  const c = cfg();
  return Boolean(c.enabled && c.token && c.phoneNumberId);
};

const sendText = async (to, body) => {
  const c = cfg();
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { preview_url: false, body: String(body || "").slice(0, 4096) },
  };

  if (!isLive()) {
    logger.info(`WhatsApp[mock] → ${to}: ${String(body || "").slice(0, 80)}`);
    return { ok: true, mode: "mock" };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), c.timeoutMs);
    let res;
    try {
      res = await fetch(
        `https://graph.facebook.com/${c.apiVersion}/${c.phoneNumberId}/messages`,
        {
          method: "POST",
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${c.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        }
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.error(`WhatsApp send failed ${res.status}: ${text.slice(0, 200)}`);
      return { ok: false, status: res.status };
    }
    return { ok: true, mode: "live" };
  } catch (error) {
    logger.error(`WhatsApp send error: ${error.message}`);
    return { ok: false, error: error.message };
  }
};

// Interactive "send your location" request (Cloud API location_request_message).
const requestLocation = async (to, body = "Please share your location to find nearby pharmacies.") => {
  const c = cfg();
  if (!isLive()) {
    logger.info(`WhatsApp[mock] location request → ${to}`);
    return { ok: true, mode: "mock" };
  }
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: { type: "location_request_message", body: { text: body }, action: { name: "send_location" } },
  };
  try {
    const res = await fetch(
      `https://graph.facebook.com/${c.apiVersion}/${c.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
      }
    );
    return { ok: res.ok };
  } catch (error) {
    logger.error(`WhatsApp location request error: ${error.message}`);
    return { ok: false };
  }
};

const health = () => {
  const c = cfg();
  return { mode: isLive() ? "live" : "mock", enabled: c.enabled, phoneNumberIdConfigured: Boolean(c.phoneNumberId) };
};

module.exports = { sendText, requestLocation, isLive, health };
