"use strict";

// WhatsApp Cloud API webhook router.
//   GET  /webhook/whatsapp → Meta verification handshake (hub.challenge)
//   POST /webhook/whatsapp → inbound message events
// Inbound messages are parsed and handed to the channel-agnostic processor,
// then the reply is sent back via the Cloud API client. Always responds 200
// quickly to Meta (best practice) and processes asynchronously.

const express = require("express");
const client = require("./whatsappClient");
const { processTextMessage, processLocationMessage } = require("./messageProcessor");
const logger = require("../../utils/logger");

const verifyToken = () => process.env.WHATSAPP_VERIFY_TOKEN || "medifast-careops-verify";

// Extract the first message + sender from a Cloud API webhook payload.
const parseInbound = (body) => {
  try {
    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];
    if (!message) return null;
    const from = message.from;
    if (message.type === "text") {
      return { type: "text", from, text: message.text?.body || "" };
    }
    if (message.type === "location") {
      return {
        type: "location",
        from,
        latitude: message.location?.latitude,
        longitude: message.location?.longitude,
      };
    }
    if (message.type === "interactive") {
      const ir = message.interactive;
      const text =
        ir?.button_reply?.title || ir?.list_reply?.title || ir?.nfm_reply?.body || "";
      return { type: "text", from, text };
    }
    return { type: "unsupported", from };
  } catch {
    return null;
  }
};

const handleInbound = async (inbound) => {
  if (!inbound) return;
  try {
    let reply;
    if (inbound.type === "text") {
      reply = await processTextMessage({ from: inbound.from, text: inbound.text });
    } else if (inbound.type === "location") {
      reply = await processLocationMessage({
        from: inbound.from,
        latitude: inbound.latitude,
        longitude: inbound.longitude,
      });
    } else {
      reply = "I can read medicine names, symptoms, and your shared location. Try sending a medicine name.";
    }
    if (reply) await client.sendText(inbound.from, reply);
  } catch (error) {
    logger.error(`WhatsApp handleInbound error: ${error.message}`);
  }
};

const createWhatsAppRouter = () => {
  const router = express.Router();

  // Meta verification handshake.
  router.get("/webhook/whatsapp", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === verifyToken()) {
      logger.info("WhatsApp webhook verified.");
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  });

  // Inbound messages.
  router.post("/webhook/whatsapp", (req, res) => {
    // Acknowledge immediately; process asynchronously (Meta best practice).
    res.sendStatus(200);
    const inbound = parseInbound(req.body);
    if (inbound) handleInbound(inbound).catch((e) => logger.error(`wa async: ${e.message}`));
  });

  router.get("/api/whatsapp/health", (req, res) => res.json(client.health()));

  return router;
};

module.exports = { createWhatsAppRouter, parseInbound, handleInbound };
