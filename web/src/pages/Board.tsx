import { useCallback, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { api, haptic } from "../api.ts";
import { useLive, useNow, km, secs, clock } from "../hooks.ts";
import { MapView } from "../components/MapView.tsx";

export type Answer = "have" | "tomorrow" | "alt" | "no";
const WORD: Record<Answer, string> = { have: "Has it", tomorrow: "By tomorrow", alt: "Alt. brand", no: "No" };
const ICON: Record<Answer, string> = { have: "✅", tomorrow: "⏳", alt: "🔁", no: "❌" };

export const rowState = (r: any): string =>
  !r.answers ? "pending" : r.complete ? "have" : r.have + r.tomorrow > 0 ? "tomorrow" : r.alt > 0 ? "alt" : "no";

export default function Board() {
  const { id } = useParams();
  const filter = useCallback((_t: string, d: any) => !d.askId || d.askId === id || !!d.reservationId, [id]);
  const { data: b, error, reload } = useLive<any>(id ? `/asks/${id}` : null, filter);
  const now = useNow(1000);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setActionError(null);
    try { await fn(); haptic("success"); await reload(); } catch (e: any) { setActionError(e.message); haptic("error"); } finally { setBusy(null); }
  };

  const pins = useMemo(() => (b?.rows ?? []).map((r: any) => ({
    id: r.recipientId, lat: r.pharmacy.lat, lng: r.pharmacy.lng, title: r.pharmacy.name, state: rowState(r),
    big: r.state === "chosen", pulse: r.state === "pending" && b.ask.status === "open", label: `${r.pharmacy.name} · ${km(r.distanceM)}`,
  })), [b]);

  if (error) return <div className="mini"><div className="err">{error}</div></div>;
  if (!b) return <div className="mini"><div className="mini-head"><p className="hint">Loading the live board…</p></div></div>;

  const { ask, counts } = b;
  const open = ask.status === "open";
  const demo = b.rows.some((r: any) => r.pharmacy.demo);
  const rx = ask.items.some((i: any) => i.schedule === "rx");

  return (
    <div className="mini">
      <header className="mini-head">
        <span className="eyebrow" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {open && <span className="live-dot" />} Request {ask.id}
        </span>
        <h1>
          {open ? `Asked ${counts.asked} pharmacies` : ask.status === "reserved" ? "Reserved" : ask.status === "expired" ? "Request expired" : "Request cancelled"}
        </h1>
        <p className="hint">
          Near {ask.place} · {ask.radius_km} km · {counts.answered} answered
          {b.fastestMs != null && ` · fastest in ${secs(b.fastestMs)}`}
          {open && ` · open ${Math.max(1, Math.ceil((ask.expires_at - now) / 60_000))} more min`}
        </p>
      </header>
      {open && <div className="progress" aria-hidden="true"><i style={{ width: `${(counts.answered / Math.max(1, counts.asked)) * 100}%` }} /></div>}
      <div className="items">
        {ask.items.map((i: any) => <span key={i.productId} className="tag">{i.label}{i.qty > 1 ? ` ×${i.qty}` : ""}{i.schedule === "rx" ? " ℞" : ""}</span>)}
      </div>

      <MapView pins={pins} you={{ lat: ask.lat, lng: ask.lng }} radiusKm={ask.radius_km} />

      {actionError && <div className="err" role="alert">{actionError}</div>}

      {b.reservations.length > 0 && (
        <section className="mini-sec">
          <h2>Your pickup{b.reservations.length > 1 ? "s" : ""}</h2>
          {b.reservations.map((res: any) => {
            const row = b.rows.find((r: any) => r.recipientId === res.recipient_id);
            const steps = ["held", "ready", "collected"];
            const at = steps.indexOf(res.status);
            const active = res.status === "held" || res.status === "ready";
            return (
              <div key={res.id} className="res" style={{ borderTop: "1px solid var(--line-2)" }}>
                <div className="prow-top"><b>{row?.pharmacy.name}</b><small>{row && km(row.distanceM)}</small></div>
                <div><span className="hint" style={{ fontSize: 13 }}>Pickup code</span><div className="code">{res.code}</div></div>
                <div className="timeline">
                  {at >= 0 ? steps.map((s, i) => <span key={s} className={i <= at ? "on" : ""}>{s === "held" ? "Set aside" : s === "ready" ? "Ready" : "Collected"}</span>) : <span>{res.status}</span>}
                </div>
                <div className="marks">
                  {res.items.map((it: any) => (
                    <span key={it.index} className={`pill s-${it.when === "now" ? "have" : "tomorrow"}`}>{ask.items[it.index].brand}: {it.when === "now" ? "now" : "tomorrow"}</span>
                  ))}
                </div>
                {active && <p className="hint" style={{ fontSize: 13 }}>Held until {clock(res.hold_until)}. Pay at the counter.{rx ? " Bring your prescription." : ""}</p>}
                <p className="hint" style={{ fontSize: 13 }}>{row?.pharmacy.address}, {row?.pharmacy.area} · {row?.pharmacy.phone}{row?.pharmacy.demo ? " (fictional)" : ""}</p>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {row && <a className="btn btn-primary btn-sm" href={`https://www.google.com/maps/dir/?api=1&destination=${row.pharmacy.lat},${row.pharmacy.lng}`} target="_blank" rel="noreferrer">Directions</a>}
                  {active && <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => confirm("Cancel this reservation?") && act(`c${res.id}`, () => api(`/reservations/${res.id}/cancel`, {}))}>Cancel</button>}
                </div>
              </div>
            );
          })}
        </section>
      )}

      {open && b.split && (
        <section className="mini-sec">
          <div className="split">
            <b>🧩 Nobody has everything, but two shops do</b>
            <div className="marks" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {b.split.parts.map((p: any) => {
                const row = b.rows.find((r: any) => r.recipientId === p.recipientId);
                return <span key={p.recipientId} className="pill s-alt">{row.pharmacy.name}: {p.items.map((i: number) => ask.items[i].brand).join(", ")}</span>;
              })}
            </div>
            <span className="hint" style={{ fontSize: 13 }}>{km(b.split.distanceM)} total distance</span>
            <button className="btn btn-dark btn-sm" disabled={!!busy} onClick={() => act("split", () => api(`/asks/${ask.id}/reserve`, { split: true }))}>Reserve both</button>
          </div>
        </section>
      )}

      <section className="mini-sec">
        <h2>Answers</h2>
        {b.rows.map((r: any) => (
          <div key={r.recipientId} className={`prow${r.answers ? "" : " waiting"}`}>
            <div className="prow-top">
              <span style={{ display: "flex", gap: 8, alignItems: "center" }}><span className={`dot s-${rowState(r)}`} /><b>{r.pharmacy.name}</b></span>
              <small>{km(r.distanceM)}{r.responseMs != null ? ` · ${secs(r.responseMs)}` : ""}</small>
            </div>
            {r.answers ? (
              <>
                <div className="marks">
                  {r.answers.map((a: Answer, i: number) => <span key={i} className={`pill s-${a}`}>{ICON[a]} {ask.items[i].brand}{a !== "have" ? `: ${WORD[a].toLowerCase()}` : ""}</span>)}
                </div>
                {(r.price || r.note) && <span className="note">{r.price ? `Quoted ₹${r.price}` : ""}{r.note ? ` · ${r.note}` : ""}</span>}
                {open && r.reservable && (
                  <button className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => act(`r${r.recipientId}`, () => api(`/asks/${ask.id}/reserve`, { recipientId: r.recipientId }))}>
                    {busy === `r${r.recipientId}` ? "Reserving…" : `Reserve ${r.have + r.tomorrow} of ${ask.items.length}`}
                  </button>
                )}
              </>
            ) : (
              <span className="note">{r.state === "pending" ? "Checking shelves…" : "No answer"}</span>
            )}
          </div>
        ))}
      </section>

      <p className="hint" style={{ padding: "4px 18px", fontSize: 13 }}>
        {b.rows.some((r: any) => r.alt > 0) && "🔁 means the pharmacist has a same-composition brand. You decide at the counter; nothing is swapped without you. "}
        {rx && "℞ The pharmacist checks your prescription at the counter. "}
        MediFast shows what pharmacists tell us. It isn't medical advice{demo ? ", and this demo's pharmacies are fictional" : ""}.
      </p>
    </div>
  );
}
