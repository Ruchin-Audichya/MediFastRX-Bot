import { Link } from "react-router-dom";
import { useLive, clock } from "../hooks.ts";

const STATUS: Record<string, string> = { open: "📡 Waiting for answers", reserved: "✅ Reserved", expired: "⌛ Expired", cancelled: "✖️ Cancelled" };

export default function Me() {
  const { data: d, error } = useLive<any>("/my");
  if (error) return <div className="mini"><div className="err">{error}</div></div>;
  if (!d) return <div className="mini"><div className="mini-head"><p className="hint">Loading…</p></div></div>;
  return (
    <div className="mini">
      <header className="mini-head"><span className="eyebrow">MediFast</span><h1>Your requests</h1><p className="hint">Start a new one in the chat: just type a medicine name.</p></header>
      <section className="mini-sec">
        {!d.asks.length && <p className="list-row hint">No requests yet.</p>}
        {d.asks.map((a: any) => (
          <Link key={a.id} className="list-row" to={`/app/ask/${a.id}`}>
            <span><b>{a.items.join(", ")}</b><br /><small>{STATUS[a.status]} · {a.answered}/{a.asked} answered · {clock(a.created_at)}</small></span>
            <span aria-hidden="true">›</span>
          </Link>
        ))}
      </section>
      <section className="mini-sec">
        <h2>My medicines</h2>
        {!d.saved.length && <p className="list-row hint">Save a list after pickup for one-tap refills (/meds in the chat).</p>}
        {d.saved.map((s: any) => <div key={s.id} className="list-row"><span>{s.label}</span><small>× {s.qty}</small></div>)}
      </section>
    </div>
  );
}
