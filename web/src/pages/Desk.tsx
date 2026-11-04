import { useState } from "react";
import { api, haptic } from "../api.ts";
import { useLive, useNow, km, secs, clock } from "../hooks.ts";
import type { Answer } from "./Board.tsx";

const OPTIONS: { a: Answer; label: string }[] = [
  { a: "have", label: "✅ Have" },
  { a: "tomorrow", label: "⏳ Tmrw" },
  { a: "alt", label: "🔁 Alt" },
  { a: "no", label: "❌ No" },
];

export default function Desk() {
  const { data: d, error, reload } = useLive<any>("/desk");
  const now = useNow(5000);
  const [prices, setPrices] = useState<Record<number, string>>({});
  const [msg, setMsg] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setMsg(null);
    try { await fn(); haptic(ok ? "success" : "light"); if (ok) setMsg(ok); await reload(); } catch (e: any) { setMsg(e.message); haptic("error"); }
  };

  if (error) return <div className="mini"><div className="err">{error}</div></div>;
  if (!d) return <div className="mini"><div className="mini-head"><p className="hint">Opening your desk…</p></div></div>;
  const { pharmacy: ph, stats } = d;
  const waiting = d.open.filter((o: any) => o.state === "pending");

  return (
    <div className="mini">
      <header className="mini-head">
        <span className="eyebrow">Pharmacy desk{ph.demo ? " · demo" : ""}</span>
        <h1>{ph.name}</h1>
        <p className="hint">{ph.area} · {ph.status === "approved" ? (ph.accepting ? "Receiving requests" : "Closed: not receiving requests") : `Status: ${ph.status}`}</p>
        {ph.status === "approved" && (
          <label className="switch" style={{ marginTop: 6 }}>
            <input type="checkbox" checked={!!ph.accepting} onChange={(e) => act(() => api("/desk/accepting", { on: e.target.checked }))} />
            {ph.accepting ? "Open" : "Closed"}
          </label>
        )}
      </header>

      <section className="mini-sec">
        <div className="desk-stats">
          <div><b>{stats.responseRate != null ? `${Math.round(stats.responseRate * 100)}%` : "–"}</b><span>answered</span></div>
          <div><b>{stats.medianResponseMs != null ? secs(stats.medianResponseMs) : "–"}</b><span>median reply</span></div>
          <div><b>{stats.collected}</b><span>picked up</span></div>
        </div>
      </section>

      {msg && <div className="err" role="status" style={{ background: "var(--brand-soft)", color: "var(--brand-ink)" }}>{msg}</div>}

      <section className="mini-sec">
        <h2>Requests {waiting.length ? `· ${waiting.length} waiting` : ""}</h2>
        {!d.open.length && <p className="list-row hint">No open requests. They arrive here and in your Telegram chat.</p>}
        {d.open.map((o: any) => {
          const marks: (Answer | null)[] = o.state === "pending" ? o.draft : o.answers;
          const marked = marks.filter(Boolean).length;
          const editing = o.state === "pending";
          return (
            <div key={o.recipientId} className="req">
              <div className="prow-top">
                <b>{editing ? "New request" : "Answer sent ✓"}</b>
                <small>{km(o.distanceM)} away · {Math.max(1, Math.ceil((o.ask.expiresAt - now) / 60_000))} min left</small>
              </div>
              {o.ask.items.map((it: any, i: number) => (
                <div key={i} className="req-item">
                  <b>{it.label} × {it.qty} {it.unit}{it.qty > 1 ? "s" : ""}{it.schedule === "rx" ? " ℞" : ""}</b>
                  <small>{it.composition}</small>
                  <div className="seg" role="group" aria-label={`Answer for ${it.label}`}>
                    {OPTIONS.map((opt) => (
                      <button key={opt.a} className={`s-${opt.a}`} aria-pressed={marks[i] === opt.a} disabled={!editing}
                        onClick={() => act(() => api(`/desk/recipients/${o.recipientId}/mark`, { index: i, answer: opt.a }))}>
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {editing ? (
                <div className="req-foot">
                  <input inputMode="decimal" placeholder="₹ total (optional)" aria-label="Total price in rupees" value={prices[o.recipientId] ?? (o.price ?? "")}
                    onChange={(e) => setPrices({ ...prices, [o.recipientId]: e.target.value.replace(/[^\d.]/g, "") })} />
                  <button className="btn btn-primary" onClick={() => act(() => api(`/desk/recipients/${o.recipientId}/submit`, { fill: "no", price: prices[o.recipientId] ? Number(prices[o.recipientId]) : undefined }), "Answer sent")}>
                    {marked === o.ask.items.length ? "Send answer" : marked ? "Send (rest ❌)" : "Send"}
                  </button>
                  {!marked && <button className="btn btn-ghost" onClick={() => act(() => api(`/desk/recipients/${o.recipientId}/submit`, { all: "have" }), "Answer sent")}>Have everything</button>}
                </div>
              ) : (
                <div className="req-foot">
                  {o.price && <span className="tag">Quoted ₹{o.price}</span>}
                  <button className="btn btn-ghost btn-sm" onClick={() => act(() => api(`/desk/recipients/${o.recipientId}/edit`, {}))}>Edit answer</button>
                </div>
              )}
            </div>
          );
        })}
      </section>

      <section className="mini-sec">
        <h2>Pickups</h2>
        {!d.holds.length && <p className="list-row hint">No active reservations.</p>}
        {d.holds.map((h: any) => (
          <div key={h.id} className="req">
            <div className="prow-top"><span><span className="hint" style={{ fontSize: 12 }}>Code</span> <b className="code" style={{ fontSize: 28 }}>{h.code}</b></span><small>{h.customer} · until {clock(h.holdUntil)}</small></div>
            <div className="marks" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {h.items.map((it: any, i: number) => <span key={i} className={`pill s-${it.when === "now" ? "have" : "tomorrow"}`}>{it.label} ×{it.qty}{it.when === "tomorrow" ? " · tomorrow" : ""}{it.schedule === "rx" ? " ℞" : ""}</span>)}
            </div>
            {h.items.some((it: any) => it.schedule === "rx") && <small className="hint">℞ Check the prescription before handing over.</small>}
            <div className="req-foot">
              {h.status === "held" && <button className="btn btn-dark btn-sm" onClick={() => act(() => api(`/desk/reservations/${h.id}`, { status: "ready" }), "Customer notified: ready")}>📦 Ready</button>}
              <button className="btn btn-primary btn-sm" onClick={() => act(() => api(`/desk/reservations/${h.id}`, { status: "collected" }), "Marked collected")}>✅ Collected</button>
              <button className="btn btn-ghost btn-sm" onClick={() => confirm("Tell the customer you can't fulfil this?") && act(() => api(`/desk/reservations/${h.id}`, { status: "declined" }))}>Can't fulfil</button>
            </div>
          </div>
        ))}
        {d.recent.map((r: any) => (
          <div key={r.id} className="list-row"><span>Code {r.code}</span><small>{r.status} · {clock(r.updatedAt)}</small></div>
        ))}
      </section>
    </div>
  );
}
