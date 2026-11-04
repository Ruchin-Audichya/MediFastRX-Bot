import { InlineKeyboard } from "grammy";
import { label, type Product } from "../catalog/catalog.ts";
import { km } from "../domain/geo.ts";
import type { Answer, Ask, Board, BoardRow, DraftItem, MediFast, Pharmacy, Recipient, Reservation } from "../domain/medifast.ts";
import type { Area } from "../domain/seed.ts";

export type View = { text: string; keyboard?: InlineKeyboard };
export type Links = { board: (askId: string) => { url: string; webApp: boolean } | null; desk: () => { url: string; webApp: boolean } | null };

export const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const time = (ms: number) => new Date(ms).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
const secs = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)} min`);
const RX = " ℞";
export const ICON: Record<Answer, string> = { have: "✅", tomorrow: "⏳", alt: "🔁", no: "❌" };
const WORD: Record<Answer, string> = { have: "has it", tomorrow: "by tomorrow", alt: "alternative brand", no: "no" };

const linkButton = (kb: InlineKeyboard, text: string, link: { url: string; webApp: boolean } | null) => {
  if (!link) return kb;
  return link.webApp ? kb.webApp(text, link.url) : kb.url(text, link.url);
};

// ───────────── Customer ─────────────

export function welcome(name: string): View {
  return {
    text:
      `<b>Hi ${esc(name.split(" ")[0])} 👋 I'm MediFast.</b>\n\n` +
      `Tell me which medicines you need. I'll ask every participating chemist near you <b>at once</b>, ` +
      `and you'll see who has them, live, within minutes. Reserve at one, pick up and pay at the counter.\n\n` +
      `<b>Try it:</b> type a name like <code>Dolo 650</code>, paste your list, or send a photo of a printed prescription.`,
    keyboard: new InlineKeyboard().text("🧾 My list", "list").text("💊 My medicines", "meds").row().text("📷 Scan a prescription", "scan").text("❓ How it works", "help"),
  };
}

export const help: View = {
  text:
    `<b>How MediFast works</b>\n\n` +
    `1️⃣ <b>Build your list.</b> Type names or send a prescription photo. You confirm the exact strength and form. I never guess.\n` +
    `2️⃣ <b>Ask nearby.</b> Your list goes to participating pharmacies within 1, 2 or 5 km.\n` +
    `3️⃣ <b>Watch answers arrive.</b> Each pharmacist taps: ✅ have · ⏳ by tomorrow · 🔁 alternative brand · ❌ no.\n` +
    `4️⃣ <b>Reserve.</b> Pick one shop, or a two-shop split. You get a 4-digit pickup code. Pay at the counter.\n\n` +
    `<b>Good to know</b>\n` +
    `• ℞ items: carry your prescription. The pharmacist checks it before handing over.\n` +
    `• No medical advice, no substitutions without you, no online payment.\n` +
    `• Habit-forming medicines aren't broadcast.\n\n` +
    `Commands: /list · /asks · /meds · /scan · /privacy · /partner (for pharmacies)`,
};

export const privacy: View = {
  text:
    `<b>Privacy, briefly</b>\n\n` +
    `• Pharmacies see your <b>medicine list and rough distance</b>, never your name, number or exact location, until you reserve. Then the chosen shop sees your first name.\n` +
    `• Prescription photos are read once to extract medicine names, then discarded. They are never forwarded.\n` +
    `• Your location is stored only to find nearby pharmacies. Send /forget to erase your list, location and saved medicines.`,
};

export function productCard(p: Product, qty = 1): View {
  const parts = [`<b>${esc(label(p))}</b>${p.schedule === "rx" ? RX : ""}`, `<i>${esc(p.composition)}</i>`];
  if (p.schedule === "rx") parts.push("℞ Prescription medicine. Carry your prescription at pickup.");
  parts.push("\nCheck this matches the strip or prescription, then add it.");
  return {
    text: parts.join("\n"),
    keyboard: new InlineKeyboard().text(`✚ Add to list${qty > 1 ? ` (×${qty})` : ""}`, `add:${p.id}:${qty}`).text("Not this", "nope"),
  };
}

export function chooser(reason: string, query: string, options: Product[], qty = 1): View {
  const lead: Record<string, string> = {
    variants: `There's more than one <b>${esc(query)}</b>. Which one is on your strip?`,
    ingredient: `<b>${esc(query)}</b> is an ingredient. These products contain it. Pick the exact one on your prescription:`,
    fuzzy: `I couldn't find <b>${esc(query)}</b> exactly. Did you mean one of these?`,
    "no-such-variant": `I don't have <b>${esc(query)}</b> in that strength or form. I only know these. Check the strip:`,
  };
  const kb = new InlineKeyboard();
  options.slice(0, 8).forEach((p) => kb.text(`${label(p)}${p.schedule === "rx" ? RX : ""}`, `add:${p.id}:${qty}`).row());
  kb.text("None of these", "nope");
  return { text: lead[reason] ?? lead.fuzzy, keyboard: kb };
}

export function notFound(query: string): View {
  return {
    text: `I couldn't find <b>${esc(query)}</b> in the catalog.\n\nTry the brand name exactly as printed on the strip (for example <code>Pan 40</code>), or the salt name (for example <code>pantoprazole</code>).`,
  };
}

export function listCard(mf: MediFast, items: DraftItem[], note = ""): View {
  if (!items.length)
    return {
      text: `${note ? note + "\n\n" : ""}🧾 <b>Your list is empty.</b>\nType a medicine name or send a prescription photo.`,
      keyboard: new InlineKeyboard().text("💊 My medicines", "meds").text("📷 Scan", "scan"),
    };
  const rows = items.map((i, n) => {
    const p = mf.catalog.get(i.productId)!;
    return `${n + 1}. <b>${esc(label(p))}</b>${p.schedule === "rx" ? RX : ""} × ${i.qty} ${p.unit}${i.qty > 1 ? "s" : ""}\n    <i>${esc(p.composition)}</i>`;
  });
  const kb = new InlineKeyboard();
  items.forEach((i) => {
    const p = mf.catalog.get(i.productId)!;
    kb.text("−", `q:${i.productId}:-1`).text(`${p.brand.slice(0, 18)} ×${i.qty}`, `q:${i.productId}:0`).text("+", `q:${i.productId}:1`).text("🗑", `rm:${i.productId}`).row();
  });
  kb.text("📡 Ask pharmacies nearby", "go").row().text("💾 Save to My medicines", "savelist").text("Clear", "clr");
  const rx = items.some((i) => mf.catalog.get(i.productId)!.schedule === "rx");
  return {
    text: `${note ? note + "\n\n" : ""}🧾 <b>Your list</b>\n\n${rows.join("\n")}${rx ? "\n\n℞ = prescription medicine. Carry your prescription at pickup." : ""}\n\nAdd more by typing, or ask pharmacies now.`,
    keyboard: kb,
  };
}

export function whereCard(areas: Area[]): View {
  const kb = new InlineKeyboard();
  areas.forEach((a, i) => { kb.text(a.name, `area:${a.id}`); if (i % 2) kb.row(); });
  return { text: `📍 <b>Where should I look?</b>\n\nTap <b>Share location</b> below for the most accurate distances, or pick an area of Jaipur:`, keyboard: kb };
}

export function confirmAsk(place: string, radius: number, count: number, nearestM: number | null, items: number): View {
  const kb = new InlineKeyboard();
  [1, 2, 5].forEach((r) => kb.text(r === radius ? `• ${r} km •` : `${r} km`, `rad:${r}`));
  kb.row();
  if (count) kb.text(`📡 Send to ${count} pharmac${count === 1 ? "y" : "ies"}`, "send").row();
  kb.text("📍 Change area", "where");
  return {
    text: count
      ? `📡 <b>Ready to ask</b>\n\n${items} medicine${items > 1 ? "s" : ""} → <b>${count}</b> participating pharmac${count === 1 ? "y" : "ies"} within <b>${radius} km</b> of ${esc(place)}.\n\nThey'll see your list and distance only, not who you are.`
      : `😕 No participating pharmacy within <b>${radius} km</b> of ${esc(place)} yet.${nearestM ? ` The nearest is ${km(nearestM)} away. Try a wider radius.` : ""}`,
    keyboard: kb,
  };
}

function rowLine(b: Board, r: BoardRow): string {
  const name = `<b>${esc(r.pharmacy.name)}</b> · ${km(r.distanceM)}`;
  if (!r.answers) return r.state === "pending" ? `⏳ ${name}: checking…` : `▫️ ${name}: no answer`;
  const n = b.ask.items.length;
  const head = r.complete ? "✅" : r.have + r.tomorrow > 0 ? "🟡" : r.alt ? "🔁" : "❌";
  const summary = r.complete ? `has all ${n}` : r.have + r.tomorrow + r.alt === 0 ? "doesn't have these" : `${r.have} of ${n} now`;
  const exceptions = r.complete
    ? ""
    : r.answers.map((a, i) => (a === "have" ? null : `${b.ask.items[i].brand}: ${WORD[a]}`)).filter(Boolean).join("; ");
  const price = r.price ? ` · ₹${r.price}` : "";
  const speed = r.responseMs != null ? ` · replied in ${secs(r.responseMs)}` : "";
  return `${head} ${name}: ${summary}${price}${speed}${exceptions && r.have + r.tomorrow + r.alt ? `\n      <i>${esc(exceptions)}</i>` : ""}`;
}

export function boardView(b: Board, links: Links, now: number): View {
  const { ask, counts } = b;
  const items = ask.items.map((i) => `${i.brand}${i.qty > 1 ? ` ×${i.qty}` : ""}${i.schedule === "rx" ? RX : ""}`).join(" · ");
  const demo = b.rows.some((r) => r.pharmacy.demo);
  const head =
    ask.status === "open"
      ? `📡 <b>Asked ${counts.asked} pharmacies</b> near ${esc(ask.place)} · ${ask.radius_km} km`
      : ask.status === "reserved"
        ? `✅ <b>Reserved</b> · request ${ask.id}`
        : ask.status === "expired"
          ? `⌛ <b>Request expired</b> · ${counts.answered} of ${counts.asked} answered`
          : `✖️ <b>Request cancelled</b>`;
  const lines = [head, `<i>${esc(items)}</i>`, ""];
  const shown = b.rows.filter((r) => r.answers);
  shown.forEach((r) => lines.push(rowLine(b, r)));
  if (ask.status === "open" && counts.waiting) lines.push(`⏳ ${counts.waiting} still checking…`);
  if (ask.status === "open" && !shown.length) lines.push("Pharmacists are checking their shelves. Answers will appear here.");
  if (ask.status === "open" && b.split) {
    const names = b.split.parts.map((p) => {
      const row = b.rows.find((r) => r.recipientId === p.recipientId)!;
      return `${row.pharmacy.name} (${p.items.map((i) => ask.items[i].brand).join(", ")})`;
    });
    lines.push("", `🧩 <b>Nobody has everything, but two shops do:</b> ${esc(names.join(" + "))} · ${km(b.split.distanceM)} total`);
  }
  if (ask.status === "open") lines.push("", `⏱ Open for ${Math.max(1, Math.ceil((ask.expires_at - now) / 60_000))} more min`);
  if (ask.items.some((i) => i.schedule === "rx")) lines.push("℞ Carry your prescription. The pharmacist checks it at the counter.");
  if (demo) lines.push("<i>Demo network: fictional pharmacies.</i>");

  const kb = new InlineKeyboard();
  if (ask.status === "open") {
    b.best.forEach((r) => kb.text(`🎟 Reserve · ${r.pharmacy.name.slice(0, 22)} (${r.have + r.tomorrow}/${ask.items.length})`, `res:${ask.id}:${r.recipientId}`).row());
    if (b.split) kb.text("🧩 Reserve the two-shop split", `split:${ask.id}`).row();
    linkButton(kb, "🗺 Live map", links.board(ask.id));
    kb.text("✖️ Cancel request", `cx:${ask.id}`);
  } else if (ask.status === "expired" || ask.status === "cancelled") {
    kb.text("🔁 Ask again", `again:${ask.id}`);
  } else linkButton(kb, "🗺 Details", links.board(ask.id));
  return { text: lines.join("\n"), keyboard: kb };
}

export function reservationCard(mf: MediFast, res: Reservation, ask: Ask, viewer: "customer" | "pharmacy"): View {
  const ph = mf.pharmacies.get(res.pharmacy_id)!;
  const rec = mf.answers.get(res.recipient_id)!;
  const fmt = (when: "now" | "tomorrow") =>
    res.items.filter((i) => i.when === when).map((i) => `${esc(ask.items[i.index].label)} × ${ask.items[i.index].qty}${ask.items[i.index].schedule === "rx" ? RX : ""}`);
  const now = fmt("now"), later = fmt("tomorrow");
  const statusLine: Record<string, string> = {
    held: viewer === "customer" ? "⏳ The pharmacy is setting it aside." : "Set these aside for the customer.",
    ready: "📦 <b>Ready for pickup.</b>",
    collected: "✅ Collected. Thank you!",
    cancelled: viewer === "customer" ? "✖️ You cancelled this reservation." : "✖️ The customer cancelled.",
    declined: viewer === "customer" ? "😕 The pharmacy can't fulfil this after all. Sorry. Ask again for other shops." : "You marked this as can't fulfil.",
    expired: "⌛ Hold expired.",
  };
  const lines =
    viewer === "customer"
      ? [
          `🎟 <b>Pickup code ${res.code}</b>`,
          `<b>${esc(ph.name)}</b> · ${km(rec.distance_m)}`,
          `${esc(ph.address)}, ${esc(ph.area)}`,
          `📞 ${esc(ph.phone)}${ph.demo ? " (fictional)" : ""}`,
          "",
        ]
      : [`🎟 <b>Reservation · code ${res.code}</b>`, `For ${esc(mf.users.get(res.customer_id)!.name.split(" ")[0])} · ${km(rec.distance_m)} away`, ""];
  if (now.length) lines.push(`<b>Ready now:</b>\n${now.map((s) => "• " + s).join("\n")}`);
  if (later.length) lines.push(`<b>By tomorrow:</b>\n${later.map((s) => "• " + s).join("\n")}`);
  if (rec.price) lines.push(`Quoted: <b>₹${rec.price}</b> (pay at counter)`);
  lines.push("", statusLine[res.status]);
  if (res.status === "held" || res.status === "ready") {
    lines.push(`Held until ${time(res.hold_until)}.`);
    if (res.items.some((i) => ask.items[i.index].schedule === "rx"))
      lines.push(viewer === "customer" ? "℞ Bring your prescription." : "℞ Check the prescription before handing over.");
  }
  const kb = new InlineKeyboard();
  if (viewer === "customer") {
    kb.url("📍 Directions", `https://www.google.com/maps/dir/?api=1&destination=${ph.lat},${ph.lng}`);
    if (res.status === "held" || res.status === "ready") kb.text("✖️ Cancel", `rc:${res.id}`);
    if (res.status === "collected") kb.row().text("💾 Save for one-tap refills", `save:${ask.id}`);
    if (res.status === "declined" || res.status === "expired") kb.row().text("🔁 Ask again", `again:${ask.id}`);
  } else {
    if (res.status === "held") kb.text("📦 Ready", `rs:${res.id}:ready`);
    if (res.status === "held" || res.status === "ready") kb.text("✅ Collected", `rs:${res.id}:collected`).row().text("Can't fulfil", `rs:${res.id}:declined`);
  }
  return { text: lines.join("\n"), keyboard: kb };
}

export function savedCard(items: { product: Product; qty: number }[]): View {
  if (!items.length)
    return { text: "💊 <b>My medicines</b>\n\nNothing saved yet. After a pickup, or from your list, tap <b>Save</b> and refills become one tap." };
  return {
    text: `💊 <b>My medicines</b>\n\n${items.map((i) => `• ${esc(label(i.product))} × ${i.qty}`).join("\n")}\n\nRunning low? Put them all on your list and ask nearby.`,
    keyboard: new InlineKeyboard().text("🔁 Refill all: ask nearby", "refill").row().text("Edit list instead", "refill-list"),
  };
}

export function asksCard(mf: MediFast, asks: Ask[]): View {
  if (!asks.length) return { text: "No requests yet. Type a medicine name to start." };
  const kb = new InlineKeyboard();
  const lines = asks.map((a) => {
    const b = mf.asks.board(a.id);
    const s = { open: "📡 open", reserved: "✅ reserved", expired: "⌛ expired", cancelled: "✖️ cancelled" }[a.status];
    kb.text(`${a.id} · ${s}`, `brd:${a.id}`).row();
    return `<b>${a.id}</b> · ${s} · ${b.counts.answered}/${b.counts.asked} answered\n<i>${esc(a.items.map((i) => i.brand).join(", "))}</i>`;
  });
  return { text: `<b>Your requests</b>\n\n${lines.join("\n\n")}`, keyboard: kb };
}

// ───────────── Pharmacist ─────────────

const CODE: Record<string, Answer> = { h: "have", t: "tomorrow", a: "alt", n: "no" };
export const answerFromCode = (c: string) => CODE[c];

export function requestCard(ask: Ask, r: Recipient, links: Links): View {
  const marks = ask.items.map((_, i) => r.draft[i] ?? null);
  const header =
    r.state === "pending" ? `🔔 <b>New request</b> · ${km(r.distance_m)} away · ${esc(ask.place)}`
    : r.state === "answered" ? `📤 <b>Answer sent</b> · ${km(r.distance_m)} away`
    : r.state === "chosen" ? `🎉 <b>The customer chose you!</b> Reservation below.`
    : r.state === "closed" ? `🙏 <b>Closed.</b> ${ask.status === "cancelled" ? "The customer cancelled." : "The customer chose another pharmacy."}`
    : `⌛ <b>Request expired</b>`;
  const lines = [header, ""];
  ask.items.forEach((it, i) => {
    const m = r.state === "pending" ? marks[i] : r.answers?.[i] ?? marks[i];
    lines.push(`${m ? ICON[m] : `${i + 1}.`} <b>${esc(it.label)}</b> × ${it.qty} ${it.unit}${it.qty > 1 ? "s" : ""}${it.schedule === "rx" ? RX : ""}\n      <i>${esc(it.composition)}</i>`);
  });
  if (r.price) lines.push("", `Quoted ₹${r.price}`);
  const open = ask.status === "open" && (r.state === "pending" || r.state === "answered");
  const kb = new InlineKeyboard();
  if (open && r.state === "pending") {
    lines.push("", "Tap for each item: ✅ have · ⏳ by tomorrow · 🔁 alternative brand · ❌ no. Then send.");
    ask.items.forEach((_, i) => {
      (["h", "t", "a", "n"] as const).forEach((c) => {
        const a = CODE[c];
        kb.text(marks[i] === a ? `[${i + 1}${ICON[a]}]` : `${i + 1}${ICON[a]}`, `m:${r.id}:${i}:${c}`);
      });
      kb.row();
    });
    const marked = marks.filter(Boolean).length;
    if (marked < ask.items.length) kb.text("✅ Have everything: send", `all:${r.id}:h`).row();
    kb.text(r.price ? `💰 ₹${r.price}` : "💰 Add price", `pr:${r.id}`);
    kb.text(marked === ask.items.length ? "📤 Send answer" : `📤 Send (rest ❌)`, `sub:${r.id}`);
    if (!marked) kb.row().text("❌ Have none", `all:${r.id}:n`);
  } else if (open && r.state === "answered") {
    lines.push("", "The customer can see your answer now. You can still change it while the request is open.");
    kb.text("✏️ Edit answer", `ed:${r.id}`);
    linkButton(kb, "🖥 Desk", links.desk());
  }
  if (ask.items.some((i) => i.schedule === "rx") && r.state !== "closed" && r.state !== "expired")
    lines.push("℞ Prescription items: verify the prescription at the counter.");
  return { text: lines.join("\n"), keyboard: kb };
}

export function deskCard(mf: MediFast, ph: Pharmacy, links: Links): View {
  const s = mf.pharmacies.stats(ph.id);
  const inbox = mf.history.inbox(ph.id);
  const status = { pending: "⏳ Awaiting admin approval", approved: ph.accepting ? "🟢 Open: receiving requests" : "🔴 Closed: not receiving requests", rejected: "Not approved", suspended: "Suspended" }[ph.status];
  const kb = new InlineKeyboard();
  if (ph.status === "approved") kb.text(ph.accepting ? "🔴 Close for now" : "🟢 Open shop", `acc:${ph.accepting ? 0 : 1}`);
  linkButton(kb, "🖥 Open desk", links.desk());
  return {
    text:
      `🏪 <b>${esc(ph.name)}</b>${ph.demo ? " (demo)" : ""}\n${status}\n\n` +
      `Open requests: <b>${inbox.open.filter((o) => o.recipient.state === "pending").length}</b> waiting for you\n` +
      `Active holds: <b>${inbox.holds.length}</b>\n\n` +
      `<b>Your reliability</b>\n` +
      `Answered ${s.answered} of ${s.received}${s.responseRate != null ? ` (${Math.round(s.responseRate * 100)}%)` : ""}\n` +
      `Median reply: ${s.medianResponseMs != null ? secs(s.medianResponseMs) : "–"}\n` +
      `Reservations: ${s.reservations} · collected: ${s.collected}`,
    keyboard: kb,
  };
}

export function pendingPharmacyCard(ph: Pharmacy): View {
  return {
    text: `🏪 <b>New pharmacy signup</b>\n\n<b>${esc(ph.name)}</b>\n${esc(ph.address)}, ${esc(ph.area)}\n📞 ${esc(ph.phone)}\nLicence: <code>${esc(ph.license)}</code>\n\nCheck the licence with the state drug controller before approving.`,
    keyboard: new InlineKeyboard().text("✅ Approve", `adm:${ph.id}:approved`).text("Reject", `adm:${ph.id}:rejected`),
  };
}
