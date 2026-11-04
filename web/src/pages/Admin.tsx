import { api } from "../api.ts";
import { useLive, secs } from "../hooks.ts";

export default function Admin() {
  const { data: d, error, reload } = useLive<any>("/admin");
  if (error) return <div className="mini"><div className="err">{error}</div></div>;
  if (!d) return <div className="mini"><div className="mini-head"><p className="hint">Loading…</p></div></div>;
  const m = d.metrics;
  const review = async (id: number, decision: string) => { await api(`/admin/pharmacies/${id}`, { decision }); reload(); };
  return (
    <div className="mini">
      <header className="mini-head"><span className="eyebrow">Admin</span><h1>Network</h1></header>
      <section className="mini-sec">
        <div className="desk-stats">
          <div><b>{m.pharmacies}</b><span>live pharmacies</span></div>
          <div><b>{m.asks}</b><span>requests</span></div>
          <div><b>{m.collected}</b><span>pickups</span></div>
        </div>
      </section>
      <section className="mini-sec">
        <h2>Pharmacies</h2>
        {d.pharmacies.map((p: any) => (
          <div key={p.id} className="req">
            <div className="prow-top"><b>{p.name}{p.demo ? " (demo)" : ""}</b><span className={`pill s-${p.status === "approved" ? "have" : p.status === "pending" ? "tomorrow" : "no"}`}>{p.status}</span></div>
            <small className="hint">{p.area} · {p.phone} · licence {p.license} · answered {p.stats.answered}/{p.stats.received}{p.stats.medianResponseMs != null ? ` · median ${secs(p.stats.medianResponseMs)}` : ""}</small>
            {p.status === "pending" && (
              <div className="req-foot">
                <button className="btn btn-primary btn-sm" onClick={() => review(p.id, "approved")}>Approve</button>
                <button className="btn btn-ghost btn-sm" onClick={() => review(p.id, "rejected")}>Reject</button>
              </div>
            )}
            {p.status === "approved" && !p.demo && <div className="req-foot"><button className="btn btn-ghost btn-sm" onClick={() => confirm(`Suspend ${p.name}?`) && review(p.id, "suspended")}>Suspend</button></div>}
          </div>
        ))}
      </section>
    </div>
  );
}
