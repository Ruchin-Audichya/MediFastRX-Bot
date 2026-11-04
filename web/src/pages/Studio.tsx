import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, keyQuery, setStudioKey } from "../api.ts";
import { TelegramPhone, type ChatSnapshot } from "../components/TelegramPhone.tsx";
import { MapView, type MapPin } from "../components/MapView.tsx";
import { Mark } from "../components/Logo.tsx";
import { km, secs } from "../hooks.ts";
import { rowState } from "./Board.tsx";

type Persona = "customer" | "pharmacist" | "admin";
type StudioState = {
  personas: Record<Persona, { name: string; chat: ChatSnapshot }>;
  pharmacies: { id: number; name: string; area: string; lat: number; lng: number; studio: boolean }[];
  asks: string[];
};

const as = (p: Persona) => ({ headers: { authorization: `studio ${p}` } });
const VAISHALI_DOORSTEP = { lat: 26.9124, lng: 75.7436 };

export default function Studio() {
  const [state, setState] = useState<StudioState | null>(null);
  const [board, setBoard] = useState<any>(null);
  const [right, setRight] = useState<"pharmacist" | "admin">("pharmacist");
  const [mobile, setMobile] = useState<"customer" | "map" | "pharmacist">("customer");
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [pw, setPw] = useState("");
  const [tried, setTried] = useState(false);
  const askId = state?.asks[0] ?? null;
  const boardTimer = useRef<number | undefined>(undefined);

  const loadState = useCallback(async () => {
    try { setState(await api<StudioState>("/studio/state")); setError(null); setLocked(false); }
    catch (e: any) { if (e.code === "studio-locked") setLocked(true); else setError(e.message); }
  }, []);
  const loadBoard = useCallback(async (id: string | null) => {
    if (!id) return setBoard(null);
    try { setBoard(await api(`/asks/${id}`, undefined, as("customer"))); } catch { setBoard(null); }
  }, []);

  useEffect(() => { document.title = "Demo Studio · MediFast"; loadState(); }, [loadState]);
  useEffect(() => { loadBoard(askId); }, [askId, loadBoard]);
  useEffect(() => {
    if (locked) return;
    const es = new EventSource(`/api/studio/stream${keyQuery()}`);
    es.addEventListener("chat", (e) => {
      const { persona, chat } = JSON.parse((e as MessageEvent).data);
      setState((s) => (s ? { ...s, personas: { ...s.personas, [persona]: { ...s.personas[persona as Persona], chat } } } : s));
    });
    es.addEventListener("ask", () => {
      clearTimeout(boardTimer.current);
      boardTimer.current = window.setTimeout(async () => {
        const s = await api<StudioState>("/studio/state").catch(() => null);
        if (s) { setState(s); loadBoard(s.asks[0] ?? null); }
      }, 150);
    });
    es.onopen = () => loadState();
    return () => es.close();
  }, [loadState, loadBoard, locked]);


  const say = (p: Persona) => (text: string) => api(`/studio/${p}/text`, { text });
  const press = (p: Persona) => (messageId: number, data: string) => api(`/studio/${p}/press`, { messageId, data });
  const location = (p: Persona) => () => api(`/studio/${p}/location`, VAISHALI_DOORSTEP);
  const photo = (p: Persona) => (f: File) => api(`/studio/${p}/photo`, f, { headers: { "content-type": f.type } });
  const sample = () => api(`/studio/customer/sample-photo`, {});
  const openLink = (url: string) => window.open(url, "_blank", "noopener");
  const reset = async () => {
    if (!confirm("Clear the demo chats and requests?")) return;
    await api("/studio/reset", {});
    setBoard(null);
    loadState();
  };

  const pins: MapPin[] = useMemo(() => {
    if (!state) return [];
    const rows = new Map<number, any>((board?.rows ?? []).map((r: any) => [r.pharmacy.id, r]));
    return state.pharmacies.map((p) => {
      const r = rows.get(p.id);
      const st = r ? rowState(r) : "pending";
      return {
        id: p.id, lat: p.lat, lng: p.lng, title: p.name,
        state: r ? st : "pending",
        big: r?.state === "chosen",
        pulse: r?.state === "pending" && board?.ask.status === "open",
        label: `${p.name}${p.studio ? " (you play this one)" : ""}${r ? ` · ${km(r.distanceM)}` : ""}`,
      };
    });
  }, [state, board]);

  if (locked)
    return (
      <div className="mini" style={{ display: "grid", placeItems: "center" }}>
        <form className="card" style={{ padding: 28, width: "min(380px, 92vw)", display: "grid", gap: 12 }}
          onSubmit={(e) => { e.preventDefault(); setStudioKey(pw); setTried(true); loadState(); }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}><Mark size={30} /><b style={{ fontSize: 18 }}>Demo Studio is locked</b></div>
          <p className="hint" style={{ color: "var(--muted)", fontSize: 14 }}>Enter the studio password to run the demo.</p>
          <input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} aria-label="Studio password"
            style={{ minHeight: 44, borderRadius: 12, border: "1.5px solid var(--line)", padding: "0 12px", font: "inherit" }} />
          {tried && <p role="alert" style={{ color: "var(--no)", fontSize: 14 }}>That password didn’t work.</p>}
          <button className="btn btn-primary" type="submit">Unlock</button>
        </form>
      </div>
    );

  const ask = board?.ask;
  const quick = [
    { label: "Dolo 650", text: "Dolo 650" },
    { label: "Thyronorm", text: "thyronorm" },
    { label: "A whole list", text: "Pan 40, Dolo 650 x2, Telma 40, Montair LC" },
    { label: "📷 Sample prescription", action: () => void sample() },
    { label: "Pan 20 (no such strength)", text: "pan 20" },
    { label: "/meds", text: "/meds" },
  ];

  return (
    <div className="studio">
      <header className="studio-bar">
        <a className="title" href="/" style={{ textDecoration: "none", color: "inherit" }}>
          <Mark size={28} /> <b>MediFast Demo Studio</b>
        </a>
        <small>The real Telegram bot, running in-process. No token needed. Fictional pharmacies; the rest are simulated.</small>
        <span className="spacer" />
        <a className="btn btn-light btn-sm" href="/app/desk?as=pharmacist" target="_blank" rel="noreferrer">Pharmacy desk ↗</a>
        <button className="btn btn-light btn-sm" onClick={reset}>Reset demo</button>
      </header>

      <div className="mobile-tabs">
        <div className="tabs" role="tablist">
          {(["customer", "map", "pharmacist"] as const).map((k) => (
            <button key={k} role="tab" aria-selected={mobile === k} onClick={() => setMobile(k)}>{k === "map" ? "Live map" : k[0].toUpperCase() + k.slice(1)}</button>
          ))}
        </div>
      </div>

      {error && <div className="err">{error}</div>}
      <main className="studio-grid">
        <section className={`studio-col${mobile === "customer" ? " active" : ""}`} aria-label="Customer chat">
          <div className="col-label"><span>Customer · Aarav</span><span className="tag">Telegram</span></div>
          <TelegramPhone
            title="MediFast" subtitle="bot"
            chat={state?.personas.customer.chat ?? null}
            quick={quick}
            onText={say("customer")} onPress={press("customer")} onLocation={location("customer")} onPhoto={photo("customer")} onLink={openLink}
            emptyHint="Type /start, a medicine like “Dolo 650”, or tap a suggestion below."
          />
        </section>

        <section className={`center${mobile === "map" ? " active" : ""}`} aria-label="Live map">
          <div className="map" style={{ position: "relative" }}>
            <MapView className="map-fill" pins={pins} you={ask ? { lat: ask.lat, lng: ask.lng } : null} radiusKm={ask?.radius_km} />
            <div className="map-overlay">
              {ask ? (
                <span className="map-pill">
                  {ask.status === "open" && <span className="live-dot" />}
                  {ask.status === "open" ? `Live · ${board.counts.answered} of ${board.counts.asked} answered` : ask.status === "reserved" ? "✅ Reserved" : ask.status}
                  {board.fastestMs != null && ` · fastest ${secs(board.fastestMs)}`}
                </span>
              ) : (
                <span className="map-pill">{state?.pharmacies.length ?? "…"} demo pharmacies in Jaipur</span>
              )}
              <span className="map-pill">
                <span className="dot s-have" /> has it <span className="dot s-tomorrow" /> partly <span className="dot s-no" /> no <span className="dot s-pending" /> waiting
              </span>
            </div>
          </div>
          <div className="card guide">
            {ask ? (
              <>
                <b>Request {ask.id} · {ask.items.map((i: any) => i.brand).join(" · ")}</b>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <a className="btn btn-ghost btn-sm" href={`/app/ask/${ask.id}?as=customer`} target="_blank" rel="noreferrer">Open the Mini App board ↗</a>
                  {board.split && <span className="pill s-alt">🧩 Two-shop split available</span>}
                  {board.reservations.map((r: any) => <span key={r.id} className="pill s-have">🎟 Code {r.code} · {r.status}</span>)}
                </div>
              </>
            ) : (
              <>
                <b>Try the whole journey in about a minute</b>
                <ol>
                  <li>As <b>Aarav</b>, tap <b>A whole list</b> (or the sample prescription), then <b>Add these to my list</b>.</li>
                  <li>Tap <b>Ask pharmacies nearby</b>, then <b>Vaishali Nagar</b> or <b>Share location</b>, then <b>Send</b>.</li>
                  <li>As <b>Ravi</b> on the right, tap ✅ ⏳ 🔁 ❌ per item and <b>Send answer</b>. The other shops answer by themselves.</li>
                  <li>Watch the board message and this map update live, then <b>Reserve</b>. Ravi gets the pickup code.</li>
                </ol>
              </>
            )}
          </div>
        </section>

        <section className={`studio-col${mobile === "pharmacist" ? " active" : ""}`} aria-label="Pharmacist and admin chats">
          <div className="col-label">
            <span>{right === "pharmacist" ? "Pharmacist · Pinkcity Care" : "Admin"}</span>
            <div className="tabs" role="tablist">
              <button role="tab" aria-selected={right === "pharmacist"} onClick={() => setRight("pharmacist")}>Ravi</button>
              <button role="tab" aria-selected={right === "admin"} onClick={() => setRight("admin")}>Admin</button>
            </div>
          </div>
          <TelegramPhone
            key={right}
            title="MediFast" subtitle={right === "pharmacist" ? "bot · Pinkcity Care Chemist (demo)" : "bot · admin"}
            chat={state?.personas[right].chat ?? null}
            quick={right === "pharmacist" ? [{ label: "/desk", text: "/desk" }, { label: "/close", text: "/close" }, { label: "/open", text: "/open" }] : [{ label: "/admin", text: "/admin" }]}
            onText={say(right)} onPress={press(right)} onLocation={location(right)} onLink={openLink}
            emptyHint={right === "pharmacist" ? "Requests from nearby customers land here. Try /desk." : "Try /admin."}
          />
        </section>
      </main>
    </div>
  );
}
