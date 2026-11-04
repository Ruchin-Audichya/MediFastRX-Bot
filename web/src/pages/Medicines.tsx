import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api.ts";
import { SiteNav } from "../components/SiteNav.tsx";

type P = { id: string; label: string; brand: string; composition: string; form: string; schedule: "otc" | "rx" | "restricted"; generic: boolean };
type Jan = { code: string; name: string; unit: string; mrp: number | null; group: string | null };
type Result = {
  query: string; intent: string; found: boolean;
  focus: (P & { sameAs: P[] }) | null;
  salts: { salt: string; groups: string[]; prescription: "yes" | "some" | "no"; restricted: boolean; products: P[]; jan: Jan[] }[];
  sources: string[];
};

const EXAMPLES = ["Pan D", "Thyronorm 50", "paracetamol", "brands of azithromycin", "generic of Telma 40", "Montair LC"];
const Rx = ({ p }: { p: { schedule: string } }) =>
  p.schedule === "rx" ? <span className="pill s-tomorrow" title="Prescription medicine">℞</span> : p.schedule === "restricted" ? <span className="pill s-no">Habit-forming</span> : null;

export default function Medicines() {
  const initial = new URLSearchParams(location.search).get("q") ?? "";
  const [q, setQ] = useState(initial);
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [bot, setBot] = useState<string | null>(null);
  const [jan, setJan] = useState(0);

  useEffect(() => {
    document.title = "Medicines · MediFast";
    api("/public/overview").then((o) => { setBot(o.bot?.username ?? null); setJan(o.knowledge?.janAushadhi ?? 0); }).catch(() => {});
    if (initial) search(initial);
  }, []);

  async function search(text: string) {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    history.replaceState(null, "", `/medicines?q=${encodeURIComponent(t)}`);
    try { setRes(await api<Result>(`/public/kb?q=${encodeURIComponent(t)}`)); } finally { setBusy(false); }
  }
  const submit = (e: FormEvent) => { e.preventDefault(); search(q); };
  const pick = (t: string) => { setQ(t); search(t); };

  const askLink = (p: P) => (bot ? `https://t.me/${bot}?start=add_${p.id}` : `/studio`);
  const online = (term: string) => `https://blinkit.com/s/?q=${encodeURIComponent(term)}`;
  const restricted = res?.focus ? res.focus.schedule === "restricted" : res?.salts.some((s) => s.restricted);

  return (
    <>
      <SiteNav bot={bot} current="medicines" />
      <header className="kb-hero">
        <div className="wrap">
          <span className="eyebrow" style={{ color: "#3ee59a" }}>Medicine lookup · no AI, from our data</span>
          <h1>What’s in it, and who makes it?</h1>
          <p className="lead">Search a brand or a salt. See its exact composition, other brands with the same composition, strengths, and the Jan Aushadhi generic.</p>
          <form className="kb-search" onSubmit={submit} role="search">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. Pan D, paracetamol, generic of Telma 40" aria-label="Medicine name or question" autoFocus />
            <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "Searching…" : "Search"}</button>
          </form>
          <div className="kb-examples">
            {EXAMPLES.map((e) => <button key={e} className="chip" onClick={() => pick(e)}>{e}</button>)}
          </div>
        </div>
      </header>

      <main className="wrap kb-main">
        {!res && <p className="sub" style={{ margin: "8px 0 40px" }}>Our catalog has exact brand, strength and form for each product{jan ? `, plus ${jan.toLocaleString("en-IN")} Jan Aushadhi generics with MRP` : ""}.</p>}
        {res && !res.found && (
          <div className="card kb-card"><h2>No information on “{res.query}” yet</h2><p className="sub">Try the brand name exactly as printed on the strip, or the salt name (for example <b>pantoprazole</b>).</p></div>
        )}
        {res?.found && (
          <article className="card kb-card">
            <div className="kb-head">
              <div>
                <span className="eyebrow">{res.focus ? "Product" : "Salt"}</span>
                <h2>{res.focus ? res.focus.label : res.salts.map((s) => s.salt).join(" + ")}</h2>
                {res.focus && <p className="kb-comp">Contains <b>{res.focus.composition}</b></p>}
              </div>
              <div className="kb-tags">
                {[...new Set(res.salts.flatMap((s) => s.groups))].map((g) => <span key={g} className="tag">{g}</span>)}
                {res.focus ? <Rx p={res.focus} /> : res.salts.some((s) => s.prescription === "yes") ? <span className="pill s-tomorrow">℞ Prescription</span> : null}
                {restricted && !res.focus && <span className="pill s-no">Habit-forming</span>}
              </div>
            </div>

            {restricted && <div className="kb-warn">Habit-forming medicine. MediFast doesn’t broadcast it to pharmacies; please ask your pharmacist directly with your prescription.</div>}

            {res.focus && (
              <section>
                <h3>Same composition, other brands</h3>
                {res.focus.sameAs.length ? <div className="kb-chips">{res.focus.sameAs.map((p) => <button key={p.id} className="chip" onClick={() => pick(p.label)}>{p.label}</button>)}</div>
                  : <p className="sub">None in our catalog.</p>}
              </section>
            )}

            {res.salts.map((s) => {
              const products = s.products.filter((p) => p.id !== res.focus?.id && !res.focus?.sameAs.some((x) => x.id === p.id));
              return (
                <section key={s.salt}>
                  <h3>{res.focus ? `Other products with ${s.salt}` : "Brands, strengths and forms"}</h3>
                  {products.length ? (
                    <div className="kl-table" role="table">
                      {products.map((p) => (
                        <div key={p.id} className="kl-row" role="row">
                          <button className="kb-name" onClick={() => pick(p.label)}>{p.label}</button>
                          <span className="kb-c">{p.composition}</span>
                          <span><Rx p={p} />{p.generic && <span className="pill s-have">Generic</span>}</span>
                        </div>
                      ))}
                    </div>
                  ) : <p className="sub">No other products in our catalog.</p>}
                  {s.jan.length > 0 && (
                    <>
                      <h3>Jan Aushadhi generic</h3>
                      <div className="kl-table">
                        {s.jan.map((j) => (
                          <div key={j.code + j.name} className="kl-row">
                            <span className="kb-name" style={{ cursor: "default" }}>{j.name}</span>
                            <span className="kb-c">{j.unit}{j.group ? ` · ${j.group}` : ""}</span>
                            <span>{j.mrp != null && <b>MRP ₹{j.mrp}</b>}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </section>
              );
            })}

            {!restricted && (
              <div className="kb-actions">
                {res.focus && <a className="btn btn-primary" href={askLink(res.focus)}>📡 Ask nearby pharmacies{bot ? " on Telegram" : " (demo)"}</a>}
                <a className="btn btn-ghost" href={online(res.focus ? res.focus.brand : res.salts[0].salt)} target="_blank" rel="noreferrer">🛵 Search online (Blinkit)</a>
              </div>
            )}
            <p className="kb-foot">Information only. Your doctor or pharmacist decides what’s right for you, so don’t switch brand or strength without asking. Sources: {res.sources.join("; ")}.</p>
          </article>
        )}
      </main>
      <footer className="site"><div className="wrap"><span><b>MediFast</b>: medicine availability, answered by pharmacists.</span><span>Not a pharmacy. Not medical advice.</span></div></footer>
    </>
  );
}
