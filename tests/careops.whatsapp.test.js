"use strict";

// Unit tests for the WhatsApp Cloud API adapter — pure parsing + mock sender.
// No network, no Mongo. Validates webhook payload parsing for text / location /
// interactive messages and the mock-mode send contract.

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseInbound } = require("../src/integrations/whatsapp/router");
const client = require("../src/integrations/whatsapp/whatsappClient");
const { stripHtml, waKey } = require("../src/integrations/whatsapp/messageProcessor");

const textPayload = (body) => ({
  entry: [
    {
      changes: [
        {
          value: {
            messages: [{ from: "919876500000", type: "text", text: { body } }],
          },
        },
      ],
    },
  ],
});

test("parseInbound extracts a text message", () => {
  const parsed = parseInbound(textPayload("Dolo 650"));
  assert.deepEqual(parsed, { type: "text", from: "919876500000", text: "Dolo 650" });
});

test("parseInbound extracts a location message", () => {
  const payload = {
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                { from: "9198", type: "location", location: { latitude: 26.9, longitude: 75.8 } },
              ],
            },
          },
        ],
      },
    ],
  };
  const parsed = parseInbound(payload);
  assert.equal(parsed.type, "location");
  assert.equal(parsed.latitude, 26.9);
  assert.equal(parsed.longitude, 75.8);
});

test("parseInbound maps interactive button replies to text", () => {
  const payload = {
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  from: "9198",
                  type: "interactive",
                  interactive: { type: "button_reply", button_reply: { title: "Pregabalin" } },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const parsed = parseInbound(payload);
  assert.deepEqual(parsed, { type: "text", from: "9198", text: "Pregabalin" });
});

test("parseInbound returns null for status/empty payloads", () => {
  assert.equal(parseInbound({ entry: [{ changes: [{ value: { statuses: [{}] } }] }] }), null);
  assert.equal(parseInbound({}), null);
});

test("whatsapp client is in mock mode and send returns ok", async () => {
  assert.equal(client.isLive(), false);
  const res = await client.sendText("9198", "hello");
  assert.equal(res.ok, true);
  assert.equal(res.mode, "mock");
});

test("waKey namespaces WhatsApp ids away from Telegram ids", () => {
  assert.equal(waKey("919876500000"), "wa:919876500000");
});

test("stripHtml removes markup and unescapes entities", () => {
  assert.equal(stripHtml("<b>Dolo</b> &amp; Crocin"), "Dolo & Crocin");
});
