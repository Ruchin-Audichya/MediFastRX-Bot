import type { Api } from "grammy";
import type { MediFast, User } from "../domain/medifast.ts";
import * as V from "./views.ts";

type Ref = { chat: number | string; message: number };
export type SimHooks = { onRequest: (recipientId: number) => void; onReservation: (reservationId: string, status: string) => void };

const HTML = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };

/**
 * Turns domain events into Telegram messages. All rendering happens here, so a change
 * made from Telegram, the web desk, or the simulator renders identically everywhere.
 */
export function createNotifier(mf: MediFast, opts: { apis: Partial<Record<"live" | "studio", Api>>; links: Record<"live" | "studio", V.Links>; sim?: SimHooks; minEditGapMs?: Partial<Record<"live" | "studio", number>> }) {
  const apiFor = (u: User | undefined) => (u && u.transport !== "sim" ? opts.apis[u.transport] : undefined);
  const linksFor = (u: User | undefined) => opts.links[u?.transport === "live" ? "live" : "studio"];
  const gap = (u: User) => opts.minEditGapMs?.[u.transport as "live"] ?? (u.transport === "live" ? 1100 : 0);

  // Per-message serial queue with coalescing: only the latest render is applied.
  const queues = new Map<string, { running: boolean; next: (() => Promise<void>) | null; last: number }>();
  function serial(key: string, minGap: number, job: () => Promise<void>) {
    const q = queues.get(key) ?? { running: false, next: null, last: 0 };
    queues.set(key, q);
    q.next = job;
    if (q.running) return;
    q.running = true;
    (async () => {
      while (q.next) {
        const wait = q.last + minGap - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        const run = q.next;
        q.next = null;
        await run().catch(report);
        q.last = Date.now();
      }
      q.running = false;
      if (!q.next) queues.delete(key);
    })();
  }
  const report = (e: any) => {
    const d = String(e?.description ?? e?.message ?? e);
    if (/not modified|bot was blocked|chat not found|message to edit not found/i.test(d)) return;
    console.error("[notify]", d);
  };

  async function send(u: User | undefined, v: V.View): Promise<Ref | null> {
    const api = apiFor(u);
    if (!api || !u) return null;
    try {
      const m = await api.sendMessage(u.chat_id, v.text, { ...HTML, reply_markup: v.keyboard });
      return { chat: m.chat.id, message: m.message_id };
    } catch (e) {
      report(e);
      return null;
    }
  }
  function editLater(u: User | undefined, refJson: string | null, render: () => V.View) {
    const api = apiFor(u);
    if (!api || !u || !refJson) return;
    const ref = JSON.parse(refJson) as Ref;
    serial(`${u.transport}:${ref.chat}:${ref.message}`, gap(u), async () => {
      const v = render();
      await api.editMessageText(ref.chat, ref.message, v.text, { ...HTML, reply_markup: v.keyboard });
    });
  }

  const ownerOfPharmacy = (pharmacyId: number) => mf.users.get(mf.pharmacies.get(pharmacyId)!.owner_id);

  function renderBoard(askId: string) {
    const ask = mf.asks.get(askId);
    if (!ask) return;
    const customer = mf.users.get(ask.customer_id);
    editLater(customer, ask.board_ref, () => V.boardView(mf.asks.board(askId), linksFor(customer), mf.now()));
  }
  function renderRecipient(recipientId: number) {
    const r = mf.answers.get(recipientId);
    if (!r) return;
    const owner = ownerOfPharmacy(r.pharmacy_id);
    editLater(owner, r.message_ref, () => V.requestCard(mf.asks.get(r.ask_id)!, mf.answers.get(recipientId)!, linksFor(owner)));
  }

  mf.on("ask.created", async ({ askId }) => {
    const ask = mf.asks.get(askId)!;
    for (const r of mf.asks.recipients(askId)) {
      const owner = ownerOfPharmacy(r.pharmacy_id);
      if (owner?.transport === "sim") { opts.sim?.onRequest(r.id); continue; }
      const ref = await send(owner, V.requestCard(ask, r, linksFor(owner)));
      if (ref) mf.setRef.recipient(r.id, ref);
    }
  });
  mf.on("recipient.changed", ({ recipientId }) => renderRecipient(recipientId));
  mf.on("ask.updated", ({ askId }) => renderBoard(askId));
  mf.on("ask.closed", ({ askId }) => {
    renderBoard(askId);
    mf.asks.recipients(askId).forEach((r) => renderRecipient(r.id));
  });

  mf.on("reservation.changed", async ({ reservationId, status, by }) => {
    const res = mf.reservations.get(reservationId)!;
    const ask = mf.asks.get(res.ask_id)!;
    const customer = mf.users.get(res.customer_id);
    const owner = ownerOfPharmacy(res.pharmacy_id);
    if (owner?.transport === "sim") opts.sim?.onReservation(reservationId, status);
    if (status === "held") {
      const c = await send(customer, V.reservationCard(mf, res, ask, "customer"));
      if (c) mf.setRef.reservation(res.id, "customer", c);
      const p = await send(owner, V.reservationCard(mf, res, ask, "pharmacy"));
      if (p) mf.setRef.reservation(res.id, "pharmacy", p);
      return;
    }
    const fresh = () => mf.reservations.get(reservationId)!;
    editLater(customer, fresh().customer_ref, () => V.reservationCard(mf, fresh(), ask, "customer"));
    editLater(owner, fresh().pharmacy_ref, () => V.reservationCard(mf, fresh(), ask, "pharmacy"));
    const ph = mf.pharmacies.get(res.pharmacy_id)!;
    const nudge: Record<string, [User | undefined, string] | undefined> = {
      ready: [customer, `📦 <b>Ready for pickup</b> at ${V.esc(ph.name)}. Show code <b>${res.code}</b> at the counter.`],
      declined: [customer, `😕 ${V.esc(ph.name)} can't fulfil your reservation after all. Tap <b>Ask again</b> on the card to try other shops.`],
      collected: [customer, `✅ Collected from ${V.esc(ph.name)}. Get well soon! Tap <b>Save</b> on the card for one-tap refills next time.`],
      cancelled: by === "customer" ? [owner, `✖️ Reservation <b>${res.code}</b> was cancelled by the customer. You can put the items back.`] : undefined,
      expired: [customer, `⌛ Your hold at ${V.esc(ph.name)} expired.`],
    };
    const n = nudge[status];
    if (n) await send(n[0], { text: n[1] });
  });

  mf.on("pharmacy.submitted", async ({ pharmacyId }) => {
    const ph = mf.pharmacies.get(pharmacyId)!;
    for (const admin of mf.users.admins()) await send(admin, V.pendingPharmacyCard(ph));
  });
  mf.on("pharmacy.reviewed", async ({ pharmacyId }) => {
    const ph = mf.pharmacies.get(pharmacyId)!;
    const text =
      ph.status === "approved"
        ? `🎉 <b>${V.esc(ph.name)} is live on MediFast.</b>\n\nRequests from customers nearby will arrive here. Tap ✅/⏳/🔁/❌ per item, then send. /desk shows your stats; /close pauses requests.`
        : `Your listing for ${V.esc(ph.name)} is <b>${ph.status}</b>. Reply here if you think this is a mistake.`;
    await send(mf.users.get(ph.owner_id), { text });
  });

  return { renderBoard, renderRecipient };
}
