import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createApp, PERSONAS } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { cleanOcr } from "../src/extract/extract.ts";

function boot(extract?: (b: Buffer) => Promise<string>) {
  const app = createApp(loadConfig({ DATABASE_PATH: ":memory:", DEMO_SPEED: "0", TELEGRAM_BOT_TOKEN: "", PUBLIC_URL: "" }), { extract: extract as any });
  const s = app.studio!;
  const chat = (id: number) => s.fake.snapshot(id);
  const last = (id: number) => chat(id).messages.at(-1)!;
  const find = (id: number, re: RegExp) => [...chat(id).messages].reverse().find((m) => re.test(m.text));
  const button = (id: number, re: RegExp) => {
    for (const m of [...chat(id).messages].reverse())
      for (const row of m.inline ?? []) for (const b of row) if (re.test(b.text) && b.callback_data) return { m, b };
    throw new Error(`no button ${re} in chat ${id}:\n${chat(id).messages.map((m) => m.text + " " + JSON.stringify(m.inline?.flat().map((b) => b.text))).join("\n")}`);
  };
  const press = async (who: keyof typeof PERSONAS | { id: number; first_name: string }, re: RegExp) => {
    const p = typeof who === "string" ? PERSONAS[who] : who;
    const { m, b } = button(p.id, re);
    await s.input.press(p, m.id, b.callback_data!);
    await settle();
  };
  const say = async (who: keyof typeof PERSONAS | { id: number; first_name: string }, text: string) => {
    await s.input.text(typeof who === "string" ? PERSONAS[who] : who, text);
    await settle();
  };
  return { app, s, chat, last, find, press, say };
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 2)); };

test("customer builds a list, asks nearby, sees live answers, reserves; pharmacist answers and hands over", async () => {
  const t = boot();
  const C = PERSONAS.customer.id, P = PERSONAS.pharmacist.id;
  await t.say("customer", "/start");
  assert.match(t.last(C).text, /I'm MediFast/);

  await t.say("customer", "Dolo 650");
  assert.match(t.last(C).text, /Dolo 650 tablet/);
  await t.press("customer", /Add to list/);
  assert.match(t.last(C).text, /Your list[\s\S]*Dolo 650/);

  await t.say("customer", "thyronorm");
  assert.match(t.last(C).text, /more than one/);
  await t.press("customer", /^Thyronorm 50/);
  assert.match(t.last(C).text, /Thyronorm 50[\s\S]*℞/);

  await t.press("customer", /Ask pharmacies nearby/);
  assert.ok(t.chat(C).replyKeyboard?.flat().some((b) => b.request_location), "offers location sharing");
  await t.press("customer", /^Vaishali Nagar$/);
  assert.match(t.last(C).text, /Ready to ask[\s\S]*Vaishali Nagar/);
  assert.equal(t.chat(C).replyKeyboard, null, "picking an area dismisses the location keyboard");
  await t.press("customer", /Send to \d+ pharmacies/);

  const ask = t.app.mf.history.asksOf(t.app.mf.users.byRef(PERSONAS.customer.ref)!.id)[0];
  assert.equal(ask.status, "open");
  assert.ok(t.find(P, /New request/), "studio pharmacist receives the request card");

  // The human pharmacist marks per item, adds a price, sends.
  await t.press("pharmacist", /^1✅$/);
  await t.press("pharmacist", /^2⏳$/);
  assert.match(t.find(P, /New request/)!.text, /✅ <b>Dolo 650 tablet/);
  await t.press("pharmacist", /Add price/);
  await t.say("pharmacist", "₹ 95");
  await t.press("pharmacist", /Send answer/);
  assert.match(t.find(P, /Answer sent/)!.text, /Quoted ₹95/);

  // Simulated pharmacies answer too (speed 0), and the customer's board message is edited live.
  await settle(); await settle();
  const board = t.app.mf.asks.board(ask.id);
  assert.ok(board.counts.answered >= 2);
  const boardMsg = t.find(C, /Asked \d+ pharmacies/)!;
  assert.match(boardMsg.text, /Pinkcity Care Chemist[\s\S]*₹95/);
  assert.ok(boardMsg.edited, "board was edited in place, not re-sent");

  await t.press("customer", /Reserve · Pinkcity/);
  const card = t.find(C, /Pickup code \d{4}/)!;
  assert.match(card.text, /Ready now:[\s\S]*Dolo 650[\s\S]*By tomorrow:[\s\S]*Thyronorm 50/);
  assert.match(t.find(P, /Reservation · code/)!.text, /Check the prescription/);
  assert.match(t.find(C, /Reserved/)!.text, /Reserved/);

  await t.press("pharmacist", /^📦 Ready$/);
  assert.match(t.last(C).text, /Ready for pickup/);
  await t.press("pharmacist", /Collected/);
  await t.press("customer", /Save for one-tap refills/);
  assert.equal(t.app.mf.saved.list(t.app.mf.users.byRef(PERSONAS.customer.ref)!.id).length, 2);
  t.app.stop();
});

test("other pharmacies are told when the customer chooses someone else", async () => {
  const t = boot();
  await t.say("customer", "Dolo 650");
  await t.press("customer", /Add to list/);
  await t.press("customer", /Ask pharmacies nearby/);
  await t.press("customer", /^Vaishali Nagar$/);
  await t.press("customer", /Send to/);
  await settle(); await settle();
  await t.press("customer", /Reserve · (?!Pinkcity)/);
  assert.match(t.find(PERSONAS.pharmacist.id, /Closed|New request/)!.text, /chose another pharmacy/);
  t.app.stop();
});

test("ambiguity, unknown names and restricted medicines are handled conservatively", async () => {
  const t = boot();
  const C = PERSONAS.customer.id;
  await t.say("customer", "pan 20");
  assert.match(t.last(C).text, /don't have <b>pan 20<\/b> in that strength/);
  await t.say("customer", "qwzxv");
  assert.match(t.last(C).text, /couldn't find/);
  await t.say("customer", "alprazolam");
  await t.press("customer", /Alprazolam/);
  assert.equal(t.app.mf.drafts.get(t.app.mf.users.byRef(PERSONAS.customer.ref)!.id).length, 0);
  await t.say("customer", "Dolo 650 x2, Pan 40\nxyzzymed");
  assert.match(t.find(C, /Here's what I matched/)!.text, /Dolo 650 × 2[\s\S]*Pan 40 × 1/);
  assert.match(t.last(C).text, /Couldn't match/);
  await t.press("customer", /Add these 2/);
  assert.equal(t.app.mf.drafts.get(t.app.mf.users.byRef(PERSONAS.customer.ref)!.id).length, 2);
  t.app.stop();
});

test("a prescription photo becomes confirmable lines, never an automatic list", async () => {
  const t = boot(async () => "Dolo 650 mg tablet\nCetirizine 10 mg tablet");
  await t.s.input.photo(PERSONAS.customer, readFileSync(new URL("../data/demo-prescription.png", import.meta.url)), "image/png");
  await settle();
  const C = PERSONAS.customer.id;
  assert.match(t.find(C, /From your prescription/)!.text, /Dolo 650/);
  assert.equal(t.app.mf.drafts.get(t.app.mf.users.byRef(PERSONAS.customer.ref)!.id).length, 0, "nothing added until confirmed");
  assert.match(t.last(C).text, /contain it|Cetirizine/);
  t.app.stop();
});

test("a new pharmacy onboards in chat and goes live only after admin approval", async () => {
  const t = boot();
  const meena = { id: 2001, first_name: "Meena" };
  await t.say(meena, "/partner");
  await t.say(meena, "Meena Medical Store");
  await t.press(meena, /^Vaishali Nagar$/);
  await t.say(meena, "98765 43210");
  await t.say(meena, "RJ-20B-55555");
  assert.match(t.s.fake.snapshot(2001).messages.at(-1)!.text, /Submitted/);
  assert.match(t.find(PERSONAS.admin.id, /New pharmacy signup/)!.text, /Meena Medical Store/);
  await t.press("admin", /Approve/);
  assert.match(t.s.fake.snapshot(2001).messages.at(-1)!.text, /is live on MediFast/);
  t.app.stop();
});

test("OCR cleanup keeps medicine lines and drops clinic boilerplate", () => {
  assert.equal(cleanOcr("Dr. Sharma Clinic\nPatient: X  Age 34\nRx Dolo 650 tab\n|| Pan 40 ||\nDate 3/11"), "Dolo 650 tab\nPan 40");
});

test("questions get knowledge-base answers in chat, and product cards link to them", async () => {
  const t = boot();
  const C = PERSONAS.customer.id;
  await t.say("customer", "what is Pan D");
  assert.match(t.last(C).text, /Contains:<\/b> Pantoprazole 40 mg \+ Domperidone 30 mg/);
  await t.press("customer", /Add Pan-D to list/);
  assert.match(t.last(C).text, /Your list[\s\S]*Pan-D/);
  await t.say("customer", "Thyronorm 50");
  await t.press("customer", /ℹ️ About/);
  assert.match(t.last(C).text, /Same composition, other brands:<\/b> Eltroxin 50, Thyrox 50/);
  await t.say("customer", "/info azithromycin");
  assert.match(t.last(C).text, /Azithral 500 tablet[\s\S]*Azee 500 tablet/);
  t.app.stop();
});

test("a website deep link (/start add_<id>) puts the medicine on the list; restricted ones are refused", async () => {
  const t = boot();
  const C = PERSONAS.customer.id;
  await t.say("customer", "/start add_telma-40");
  assert.match(t.last(C).text, /added <b>Telma 40<\/b> from the website[\s\S]*Your list[\s\S]*Telma 40/);
  await t.say("customer", "/start add_gen-alprazolam-025");
  assert.match(t.last(C).text, /habit-forming/);
  assert.equal(t.app.mf.drafts.get(t.app.mf.users.byRef(PERSONAS.customer.ref)!.id).length, 1);
  t.app.stop();
});
