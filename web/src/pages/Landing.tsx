import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { api } from "../api.ts";
import { Logo } from "../components/Logo.tsx";
import { TelegramHtml } from "../components/Html.tsx";

const MapView = lazy(() => import("../components/MapView.tsx").then((m) => ({ default: m.MapView })));

type Overview = {
  demo: boolean;
  bot: { live: boolean; username: string | null };
  catalogSize: number;
  pharmacies: { name: string; area: string; lat: number; lng: number; demo: boolean }[];
  metrics: { asks: number; answers: number; pharmacies: number; collected: number };
};

// A scripted replay for the hero radar: illustrative, labelled as such.
const RADAR = [
  { x: 28, y: 30, name: "Saanjh", state: "have", text: "has all 3 · 14s" },
  { x: 74, y: 24, name: "Nahar", state: "tomorrow", text: "2 of 3 · 20s" },
  { x: 80, y: 66, name: "Lotus", state: "have", text: "has all 3 · 25s" },
  { x: 22, y: 72, name: "Kesar", state: "no", text: "none · 31s" },
  { x: 52, y: 84, name: "Gulmohar", state: "alt", text: "alt. brand · 40s" },
  { x: 60, y: 14, name: "Pinkcity", state: "have", text: "has all 3 · 9s" },
];

const BOARD_HTML =
  "📡 <b>Asked 7 pharmacies</b> near Vaishali Nagar · 2 km\n<i>Dolo 650 ×2 · Pan 40 ℞ · Thyronorm 50 ℞</i>\n\n" +
  "✅ <b>Pinkcity Care Chemist</b> · 250 m: has all 3 · ₹212 · replied in 9s\n" +
  "✅ <b>Saanjh Pharmacy</b> · 550 m: has all 3 · replied in 14s\n" +
  "🟡 <b>Nahar Medicos</b> · 1.0 km: 2 of 3 now · replied in 20s\n      <i>Thyronorm 50: by tomorrow</i>\n" +
  "❌ <b>Kesar Health Store</b> · 1.0 km: doesn't have these\n⏳ 3 still checking…\n\n⏱ Open for 28 more min";

export default function Landing() {
  const [o, setO] = useState<Overview | null>(null);
  const [lit, setLit] = useState(0);
  useEffect(() => { document.title = "MediFast: ask every chemist nearby, at once"; api<Overview>("/public/overview").then(setO).catch(() => {}); }, []);
  useEffect(() => {
    const t = setInterval(() => setLit((n) => (n >= RADAR.length + 3 ? 0 : n + 1)), 900);
    return () => clearInterval(t);
  }, []);

  const tgLink = o?.bot.username ? `https://t.me/${o.bot.username}` : null;
  const partnerLink = o?.bot.username ? `https://t.me/${o.bot.username}?start=partner` : "/studio";
  const pins = useMemo(() => (o?.pharmacies ?? []).map((p, i) => ({ id: i, lat: p.lat, lng: p.lng, state: "have", title: p.name, label: `${p.name} · ${p.area}${p.demo ? " (demo)" : ""}` })), [o]);

  return (
    <>
      <nav className="nav">
        <div className="wrap">
          <Logo />
          <div className="nav-links">
            <a href="#how">How it works</a>
            <a href="#pharmacies">For pharmacies</a>
            <a href="#trust">Trust</a>
            <a className="btn btn-light btn-sm" href="/studio">Live demo</a>
            {tgLink && <a className="btn btn-primary btn-sm" href={tgLink}>Open in Telegram</a>}
          </div>
        </div>
      </nav>

      <header className="hero">
        <div className="wrap">
          <div>
            <span className="eyebrow" style={{ color: "#3ee59a" }}>On Telegram · piloting in Jaipur</span>
            <h1 style={{ marginTop: 16 }}>Ask every chemist nearby. <em>At once.</em></h1>
            <p className="lead">
              Send your medicine list to MediFast on Telegram. Every participating pharmacy around you gets it instantly, taps what they have,
              and you watch the answers arrive. Reserve the best one, then walk in and pick up.
            </p>
            <div className="ctas">
              {tgLink ? <a className="btn btn-primary" href={tgLink}>Open MediFast in Telegram</a> : <a className="btn btn-primary" href="/studio">Try the live demo</a>}
              {tgLink ? <a className="btn btn-light" href="/studio">Watch the live demo</a> : <a className="btn btn-light" href="#how">How it works</a>}
            </div>
            <p className="fine"><span className="live-dot" /> No app to install · No stock uploads for pharmacies · Pay at the counter</p>
          </div>
          <div className="radar" aria-label="Illustration: a request reaching pharmacies around you, answers lighting up">
            {[100, 72, 44].map((s) => <div key={s} className="ring" style={{ width: `${s}%`, height: `${s}%` }} />)}
            <div className="sweep" />
            <div className="you" />
            {RADAR.map((p, i) => (
              <div key={p.name} className={`pin ${i < lit ? `on ${p.state}` : ""}`} style={{ left: `${p.x}%`, top: `${p.y}%` }}>
                <i /><span>{p.name}: {p.text}</span>
              </div>
            ))}
          </div>
        </div>
      </header>

      <section className="section">
        <div className="wrap">
          <span className="eyebrow">The problem</span>
          <h2 style={{ marginTop: 10 }}>One prescription. Four shops.<br />One missing strip.</h2>
          <p className="sub">Most medicines are easy to find. The one you need tonight, in the exact strength the doctor wrote, often isn't, and you only learn that at the counter.</p>
          <div className="problem">
            <div className="card"><b>“Out of stock” is invisible</b><p>Nothing tells you which shop has your exact strength until you've travelled there.</p></div>
            <div className="card"><b>Calling around doesn't scale</b><p>One shop at a time, numbers you don't have, and a pharmacist busy with a queue.</p></div>
            <div className="card"><b>Stock apps go stale</b><p>Inventory listings only work if shops update them constantly. Neighbourhood chemists can't, so the data drifts.</p></div>
          </div>
        </div>
      </section>

      <section className="section" id="how" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <span className="eyebrow">How it works</span>
          <h2 style={{ marginTop: 10 }}>Don't search a stale database. Ask the people who can see the shelf.</h2>
          <div className="steps">
            <div className="step"><h3>Build your list</h3><p>Type names, paste a list or send a prescription photo. You confirm the exact strength and form. MediFast never guesses.</p></div>
            <div className="step"><h3>Ask nearby</h3><p>Your list goes to participating pharmacies within 1, 2 or 5 km. They see the medicines and distance, not who you are.</p></div>
            <div className="step"><h3>Watch answers arrive</h3><p>Each pharmacist taps one answer per item. One message in your chat updates itself, plus a live map.</p>
              <div className="legend"><span className="pill s-have">✅ have</span><span className="pill s-tomorrow">⏳ by tomorrow</span><span className="pill s-alt">🔁 alt. brand</span><span className="pill s-no">❌ no</span></div>
            </div>
            <div className="step"><h3>Reserve and pick up</h3><p>Pick one shop, or let MediFast split the list across two nearby shops. Show the 4-digit code and pay at the counter.</p></div>
          </div>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 0 }}>
        <div className="wrap two">
          <div>
            <span className="eyebrow">One message, always current</span>
            <h2 style={{ marginTop: 10 }}>Your chat becomes a live board.</h2>
            <p className="sub">No refreshing, no new notifications for every reply. The request message edits itself as pharmacists answer: complete answers rise to the top, gaps are spelled out, and if nobody has everything MediFast finds the closest two-shop split.</p>
            <p className="sub">Open <b>Live map</b> for the same answers as pins on a map, inside Telegram.</p>
          </div>
          <div className="mock" style={{ marginInline: "auto" }}>
            <div className="phone" style={{ height: 520, borderRadius: 26 }}>
              <div className="tg-head"><div className="tg-avatar">💊</div><div><b>MediFast</b><small>bot</small></div></div>
              <div className="tg-body">
                <div className="msg user"><div className="bubble">Dolo 650 x2, Pan 40, Thyronorm 50</div></div>
                <div className="msg bot"><div className="bubble" style={{ fontSize: 12.5 }}><TelegramHtml html={BOARD_HTML} /></div>
                  <div className="kb"><div className="kb-row"><button tabIndex={-1}>🎟 Reserve · Pinkcity (3/3)</button></div><div className="kb-row"><button tabIndex={-1}>🗺 Live map ↗</button><button tabIndex={-1}>✖️ Cancel</button></div></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="pharmacies" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <div className="pharm two">
            <div>
              <span className="eyebrow" style={{ color: "#3ee59a" }}>For pharmacies</span>
              <h2 style={{ marginTop: 10 }}>Five seconds a request. Zero spreadsheets.</h2>
              <p className="sub">Stock-listing apps ask small chemists to maintain a database. MediFast asks one question, only when a real customer nearby needs something.</p>
              <div className="ctas" style={{ display: "flex", gap: 12, marginTop: 28, flexWrap: "wrap" }}>
                <a className="btn btn-primary" href={partnerLink}>List your pharmacy</a>
                <a className="btn btn-light" href="/studio">See the pharmacist side</a>
              </div>
            </div>
            <ul className="ticks">
              <li>Requests arrive in Telegram on the counter phone. No new app, no login.</li>
              <li>One tap per item: have, by tomorrow, alternative brand, or no. “Have everything” sends in one tap.</li>
              <li>Customers walk in with a pickup code and a list that's already set aside.</li>
              <li>Closing early? Tap Close and requests stop. Open again any time.</li>
              <li>Your reply rate and speed are visible to you, the reputation that wins walk-ins.</li>
              <li>Prescription checks stay where they belong: at your counter.</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="section" id="trust" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <span className="eyebrow">Built to be trusted</span>
          <h2 style={{ marginTop: 10 }}>Careful by design, not by disclaimer.</h2>
          <div className="trust">
            <div className="card"><h3>Exact product, never a guess</h3><p>“Pan 20” never silently becomes Pan 40. Strength, form and release type are matched exactly; anything fuzzy needs your tap.</p></div>
            <div className="card"><h3>℞ stays ℞</h3><p>Prescription medicines are marked everywhere, and the pharmacist checks the prescription at handover. MediFast doesn't sell or deliver.</p></div>
            <div className="card"><h3>No silent substitutions</h3><p>A pharmacist can say “alternative brand available”. Whether to take it is your conversation at the counter.</p></div>
            <div className="card"><h3>Habit-forming medicines aren't broadcast</h3><p>Restricted products can't be sent to a crowd of shops. You're asked to speak to a pharmacist directly.</p></div>
            <div className="card"><h3>Private by default</h3><p>Pharmacies see your list and distance only. Prescription photos are read once and discarded. /forget erases your data.</p></div>
            <div className="card"><h3>AI where it helps, nowhere else</h3><p>AI can read a prescription photo into text. Matching, answers and reservations are deterministic and human-confirmed.</p></div>
          </div>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <span className="eyebrow">{o?.demo ? "Demo network" : "The network"}</span>
          <h2 style={{ marginTop: 10 }}>{o?.demo ? "A fictional Jaipur network you can play with" : "Participating pharmacies"}</h2>
          {o?.demo && <p className="sub">These pharmacies are made up for the demo, and their replies are simulated. Real partners join through the bot and are verified before going live.</p>}
          <div className="network">
            <Suspense fallback={<div className="map" />}><MapView className="map" pins={pins} /></Suspense>
            <div className="stats">
              <div className="card stat"><b>{o?.metrics.pharmacies ?? "–"}</b><span>pharmacies {o?.demo ? "(demo)" : "live"}</span></div>
              <div className="card stat"><b>{o?.catalogSize ?? "–"}</b><span>products in the starter catalog, exact strength and form</span></div>
              <div className="card stat"><b>{o?.metrics.answers ?? "–"}</b><span>pharmacist answers so far{o?.demo ? " (incl. simulated)" : ""}</span></div>
            </div>
          </div>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <div className="cta-band">
            <h2>See it run, end to end.</h2>
            <p className="sub" style={{ color: "rgb(255 255 255 / 70%)", marginInline: "auto" }}>Demo Studio runs the real bot with a customer, a pharmacist and an admin side by side, plus the live map.</p>
            <div className="ctas">
              <a className="btn btn-primary" href="/studio">Open Demo Studio</a>
              {tgLink && <a className="btn btn-light" href={tgLink}>Open in Telegram</a>}
            </div>
          </div>
        </div>
      </section>

      <footer className="site">
        <div className="wrap">
          <span><b>MediFast</b>: medicine availability, answered by pharmacists.</span>
          <span>A 7th-semester major project. Not a pharmacy; doesn't sell, prescribe or deliver. Not medical advice.</span>
        </div>
      </footer>
    </>
  );
}
