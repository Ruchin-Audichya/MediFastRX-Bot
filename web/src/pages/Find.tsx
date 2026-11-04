import { Suspense, lazy, useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, ApiError, ensureWebSession, resetWebSession } from "../api.ts";
import { SiteNav } from "../components/SiteNav.tsx";
import { km } from "../hooks.ts";

const MapView = lazy(() => import("../components/MapView.tsx").then((m) => ({ default: m.MapView })));

type Product = { id: string; label: string; brand: string; composition: string; form: string; schedule: "otc" | "rx" | "restricted"; unit: string; generic: boolean };
type PinPlace = { pincode: string; place: string; district: string | null; state: string | null; lat: number; lng: number; source: string };
type Verification = "pharmacist-confirms" | "location-only" | "not-checked";
type Outcome<T> = { id: string; verification: Verification } & ({ status: "ok"; data: T } | { status: "empty" | "unavailable" | "skipped"; message: string });
type Network = { partners: number; nearestM: number | null; radiusKm: number; canAsk: boolean };
type Place = { name: string; lat: number; lng: number; distanceM: number; phone: string | null; hours: string | null; address: string | null; osmUrl: string };
type Directory = { places: Place[]; radiusKm: number; source: string };
type Link = { id: string; name: string; url: string; type: "pharmacy" | "quick-commerce"; note: string; affiliate: boolean };
type FindResponse =
  | { stage: "need-medicine" }
  | { stage: "not-found"; query: string }
  | { stage: "choose"; query: string; reason: string; options: Product[] }
  | { stage: "need-location"; product: Product; error?: "invalid" | "not-found" | "unavailable" }
  | { stage: "results"; product: Product; place: PinPlace; providers: Outcome<any>[]; tookMs: number };

const PIN_KEY = "medifast.pincode";
const savedPin = () => { try { return localStorage.getItem(PIN_KEY) ?? ""; } catch { return ""; } };
const EXAMPLES = ["Dolo 650", "Thyronorm 50", "Pan 40", "Azithral 500", "Montair LC"];
const LOC_ERROR = {
  invalid: "That doesn’t look like a pincode. Indian pincodes have 6 digits and don’t start with 0.",
  "not-found": "We couldn’t find that pincode. Check it, or try a neighbouring one.",
  unavailable: "We couldn’t look up that pincode right now. Please try again in a minute.",
};
const REASON: Record<string, string> = {
  variants: "This medicine comes in more than one strength or form.",
  ingredient: "Several medicines contain this.",
  fuzzy: "We’re not sure which one you meant.",
  "no-such-variant": "We don’t know that exact strength. These are the ones we know.",
};
const BADGE: Record<Verification, { text: string; cls: string; title: string }> = {
  "pharmacist-confirms": { text: "Pharmacist confirms", cls: "s-have", title: "A pharmacist answers your specific request. Nothing is shown until they do." },
  "location-only": { text: "Stock unknown", cls: "s-tomorrow", title: "We know these shops exist here. We don’t know what they have." },
  "not-checked": { text: "Not checked by MediFast", cls: "s-pending", title: "We open the platform’s own search. Availability, price and delivery are shown by them." },
};

export const Rx = ({ schedule }: { schedule: string }) =>
  schedule === "rx" ? <span className="pill s-tomorrow" title="Prescription medicine">℞ Prescription</span> : schedule === "restricted" ? <span className="pill s-no">Habit-forming · ℞</span> : <span className="pill s-have">Over the counter</span>;

function Tier({ n, title, outcome, children }: { n: number; title: string; outcome?: Outcome<any>; children: React.ReactNode }) {
  const b = outcome && BADGE[outcome.verification];
  return (
    <section className="tier card" aria-labelledby={`tier-${n}`}>
      <header>
        <span className="tier-n">{n}</span>
        <h2 id={`tier-${n}`}>{title}</h2>
        {b && <span className={`pill ${b.cls}`} title={b.title}>{b.text}</span>}
      </header>
      {outcome && outcome.status !== "ok" ? <p className={`tier-msg ${outcome.status}`}>{outcome.message}</p> : children}
    </section>
  );
}

export default function Find() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [pin, setPin] = useState(params.get("pin") ?? savedPin());
  const [res, setRes] = useState<FindResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bot, setBot] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [radius, setRadius] = useState(2);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);

  const key = `${params.get("q") ?? ""}|${params.get("id") ?? ""}|${params.get("pin") ?? ""}`;
  useEffect(() => { api("/public/overview").then((o) => setBot(o.bot?.username ?? null)).catch(() => {}); }, []);
  useEffect(() => {
    const p = params;
    if (!p.get("q") && !p.get("id")) { setRes({ stage: "need-medicine" }); return; }
    setBusy(true);
    setError(null);
    const qs = new URLSearchParams();
    for (const k of ["q", "id", "pin"]) if (p.get(k)) qs.set(k, p.get(k)!);
    api<FindResponse>(`/find?${qs}`)
      .then((r) => {
        setRes(r);
        if (r.stage === "results") {
          try { localStorage.setItem(PIN_KEY, r.place.pincode); } catch {}
          const net = r.providers.find((x) => x.id === "network");
          setRadius(net?.status === "ok" ? net.data.radiusKm : 2);
        }
      })
      .catch((e) => setError(e instanceof ApiError && e.status === 429 ? "Too many searches from this connection. Please wait a minute." : "Search failed. Please try again."))
      .finally(() => setBusy(false));
  }, [key]);

  const product = res && "product" in res ? res.product : null;
  useEffect(() => { document.title = product ? `Where to get ${product.label} · MediFast` : "Find a medicine · MediFast"; }, [product]);

  const go = (next: { q?: string; id?: string; pin?: string }) => {
    const p = new URLSearchParams();
    if (next.id) p.set("id", next.id); else if (next.q) p.set("q", next.q);
    if (next.pin) p.set("pin", next.pin);
    setParams(p);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const sameMedicine = product && (q.trim() === product.label || q.trim() === product.brand);
    go(sameMedicine ? { id: product.id, pin: pin.trim() } : { q: q.trim(), pin: pin.trim() });
  };
  const choose = (p: Product) => { setQ(p.label); go({ id: p.id, pin: pin.trim() }); };

  async function askNearby(p: Product, place: PinPlace) {
    setAsking(true);
    setAskError(null);
    const send = () => api<{ askId: string }>("/web/asks", { items: [{ productId: p.id, qty }], pin: place.pincode, radiusKm: radius });
    try {
      await ensureWebSession();
      let r: { askId: string };
      try { r = await send(); } catch (e) {
        if (!(e instanceof ApiError && e.status === 401)) throw e;
        resetWebSession(); // stale token (e.g. the server's data was reset): start a fresh session once
        await ensureWebSession();
        r = await send();
      }
      nav(`/app/ask/${r.askId}`);
    } catch (e: any) {
      setAskError(e.message);
      setAsking(false);
    }
  }

  return (
    <>
      <SiteNav bot={bot} current="find" />
      <header className="kb-hero find-hero">
        <div className="wrap">
          <span className="eyebrow" style={{ color: "#3ee59a" }}>Find a medicine</span>
          <h1>Where can I get it?</h1>
          <form className="find-form" onSubmit={submit} role="search">
            <label><span>Medicine</span>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Brand and strength, e.g. Dolo 650" autoComplete="off" required />
            </label>
            <label className="pin"><span>Pincode</span>
              <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" placeholder="302021" autoComplete="postal-code" />
            </label>
            <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "Finding…" : "Find"}</button>
          </form>
        </div>
      </header>

      <main className="wrap find">
        {error && <div className="err" role="alert">{error}</div>}
        {busy && !res && <p className="hint">Looking…</p>}

        {res?.stage === "need-medicine" && (
          <div className="find-empty">
            <p>Type a medicine with its strength, and your pincode. You’ll see participating pharmacies that can confirm stock, mapped chemists around you, and online pharmacies. You choose where to buy.</p>
            <div className="kb-examples">{EXAMPLES.map((e) => <button key={e} className="chip" onClick={() => { setQ(e); go({ q: e, pin }); }}>{e}</button>)}</div>
          </div>
        )}

        {res?.stage === "not-found" && (
          <div className="find-empty">
            <h2>We don’t know “{res.query}” yet</h2>
            <p>Check the spelling, or search by the salt name in <a href={`/medicines?q=${encodeURIComponent(res.query)}`}>Medicines</a>. Our catalog is small and growing; we never guess a medicine we don’t know.</p>
          </div>
        )}

        {res?.stage === "choose" && (
          <div className="find-choose">
            <h2>Which one exactly?</h2>
            <p className="hint">{REASON[res.reason] ?? "Several products match."} Strength and form matter, so we never pick for you.</p>
            <div className="choose-list">
              {res.options.map((o) => (
                <button key={o.id} className="card choose" onClick={() => choose(o)}>
                  <b>{o.label}</b><span>{o.composition}</span><Rx schedule={o.schedule} />
                </button>
              ))}
            </div>
          </div>
        )}

        {res?.stage === "need-location" && (
          <div className="find-choose">
            <ProductHead p={res.product} />
            <p className={res.error ? "err" : "hint"} style={{ marginTop: 16 }}>{res.error ? LOC_ERROR[res.error] : "Add your 6-digit pincode above to see where you can get it."}</p>
          </div>
        )}

        {res?.stage === "results" && (
          <Results r={res} bot={bot} qty={qty} setQty={setQty} radius={radius} setRadius={setRadius} asking={asking} askError={askError} onAsk={() => askNearby(res.product, res.place)} />
        )}
      </main>

      <footer className="site"><div className="wrap">
        <span>MediFast doesn’t sell medicines, and never shows stock or prices we haven’t been told by a pharmacist or the platform itself.</span>
        <span>Map data © OpenStreetMap contributors</span>
      </div></footer>
    </>
  );
}

function ProductHead({ p }: { p: Product }) {
  return (
    <div className="find-product">
      <div>
        <h2>{p.label}</h2>
        <p>{p.composition} · {p.form}</p>
      </div>
      <div className="find-tags"><Rx schedule={p.schedule} /><a className="chip" href={`/medicines?q=${encodeURIComponent(p.brand)}`}>About this medicine</a></div>
    </div>
  );
}

function Results({ r, bot, qty, setQty, radius, setRadius, asking, askError, onAsk }: {
  r: Extract<FindResponse, { stage: "results" }>; bot: string | null; qty: number; setQty: (n: number) => void; radius: number; setRadius: (n: number) => void; asking: boolean; askError: string | null; onAsk: () => void;
}) {
  const by = Object.fromEntries(r.providers.map((p) => [p.id, p])) as Record<string, Outcome<any>>;
  const net = by.network as Outcome<Network> | undefined;
  const dir = by.directory as Outcome<Directory> | undefined;
  const online = by.online as Outcome<{ links: Link[] }> | undefined;
  const places = dir?.status === "ok" ? dir.data.places : [];
  const pins = useMemo(() => places.map((p, i) => ({ id: i, lat: p.lat, lng: p.lng, state: "pending", title: p.name, label: `${p.name} · ${km(p.distanceM)}` })), [places]);
  const where = [r.place.place, r.place.district, r.place.state].filter((x, i, a) => x && a.indexOf(x) === i).join(", ");
  const rx = r.product.schedule !== "otc";
  const affiliates = online?.status === "ok" && online.data.links.some((l) => l.affiliate);

  return (
    <>
      <ProductHead p={r.product} />
      <p className="find-where">📍 Around <b>{where}</b> · {r.place.pincode} <span title={r.place.source}>({/approximate|Demo/i.test(r.place.source) ? "approximate location" : "India Post"})</span></p>
      {rx && <p className="find-rx">℞ This is a prescription medicine. Every option below will ask for your prescription; the pharmacist decides at handover.</p>}

      <div className="tiers">
        <Tier n={1} title="Ask pharmacies near you" outcome={net}>
          {net?.status === "ok" && (
            <>
              <p className="tier-lead"><b>{net.data.partners} participating {net.data.partners === 1 ? "pharmacy" : "pharmacies"}</b> within {net.data.radiusKm} km{net.data.nearestM != null && <>, nearest about {km(net.data.nearestM)}</>}. Send one request; each pharmacist checks the shelf and taps an answer. Usually within minutes.</p>
              <div className="ask-row">
                <label>Quantity <select value={qty} onChange={(e) => setQty(Number(e.target.value))}>{[1, 2, 3, 4, 5, 10].map((n) => <option key={n} value={n}>{n} × {r.product.unit}</option>)}</select></label>
                <label>Within <select value={radius} onChange={(e) => setRadius(Number(e.target.value))}>{[1, 2, 5].map((n) => <option key={n} value={n}>{n} km</option>)}</select></label>
                <button className="btn btn-primary" onClick={onAsk} disabled={asking}>{asking ? "Sending…" : "Ask them now"}</button>
              </div>
              {askError && <p className="err" role="alert">{askError}</p>}
              <p className="fine-print">No sign-up. Pharmacies see the medicine and your rough distance, not who you are. {bot && <>Prefer Telegram? <a href={`https://t.me/${bot}?start=add_${r.product.id}`}>Ask from the MediFast bot</a>.</>}</p>
            </>
          )}
        </Tier>

        <Tier n={2} title="Pharmacies on the map" outcome={dir}>
          {dir?.status === "ok" && (
            <>
              <p className="tier-lead">{places.length} {places.length === 1 ? "pharmacy is" : "pharmacies are"} mapped within {dir.data.radiusKm} km. We don’t know what they stock: call before you go.</p>
              <div className="dir">
                <Suspense fallback={<div className="dir-map" />}><MapView className="dir-map" pins={pins} you={r.place} /></Suspense>
                <ol className="dir-list">
                  {places.map((p) => (
                    <li key={p.osmUrl}>
                      <div><b>{p.name}</b><span>{km(p.distanceM)}{p.address && ` · ${p.address}`}</span>{p.hours && <span className="hours">🕘 {p.hours}</span>}</div>
                      <div className="dir-actions">
                        {p.phone && <a className="btn btn-ghost btn-sm" href={`tel:${p.phone.split(/[;,]/)[0].replace(/[^\d+]/g, "")}`}>Call</a>}
                        <a className="btn btn-ghost btn-sm" href={`https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`} target="_blank" rel="noopener noreferrer">Directions</a>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
              <p className="fine-print">Listings from {dir.data.source}. Missing a shop? Anyone can add it on <a href="https://www.openstreetmap.org" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>.</p>
            </>
          )}
        </Tier>

        <Tier n={3} title="Buy online" outcome={online}>
          {online?.status === "ok" && (
            <>
              <p className="tier-lead">Opens each platform’s own search for <b>{r.product.brand.replace(/\s*\(generic\)/i, "")}</b>. Their page shows whether they deliver to {r.place.pincode}, the price and the delivery time. We don’t check any of it.</p>
              <div className="online">
                {online.data.links.map((l) => (
                  <a key={l.id} className={`card online-card ${l.type}`} href={l.url} target="_blank" rel={`noopener noreferrer${l.affiliate ? " sponsored" : ""}`}>
                    <b>{l.name} ↗</b>
                    <span className="online-type">{l.type === "quick-commerce" ? "Quick commerce · fallback" : "Online pharmacy"}{l.affiliate && " · affiliate link"}</span>
                    <span>{l.note}</span>
                  </a>
                ))}
              </div>
              {affiliates && <p className="fine-print">Links marked “affiliate link” may earn MediFast a small commission at no cost to you. It never changes the order of this page.</p>}
            </>
          )}
        </Tier>
      </div>
      <p className="fine-print" style={{ marginTop: 18 }}>Answered in {(r.tookMs / 1000).toFixed(1)} s. Sources that fail are shown as unavailable; nothing is filled in.</p>
    </>
  );
}
