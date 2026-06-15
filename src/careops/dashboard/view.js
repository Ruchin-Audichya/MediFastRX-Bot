"use strict";

// Single-file HTML renderer for the CareOps dashboard. No build step, no
// client framework — just a clean, dark, auto-refreshing operations board
// optimized for a 3-minute demo on a projector.

const esc = (v) =>
  String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const STATUS_COLOR = {
  open: "#3b82f6",
  in_progress: "#f59e0b",
  investigating: "#f59e0b",
  escalated: "#ef4444",
  resolved: "#22c55e",
  closed: "#64748b",
  done: "#22c55e",
};

const pill = (status) =>
  `<span class="pill" style="background:${STATUS_COLOR[status] || "#475569"}">${esc(status)}</span>`;

const card = (label, value, color) =>
  `<div class="metric"><div class="metric-value" style="color:${color}">${value}</div><div class="metric-label">${esc(label)}</div></div>`;

const row = (cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;

const renderDashboardHtml = (snap = {}, snHealth = {}) => {
  const c = snap.counts || {};
  const actions = (snap.recentActions || [])
    .map(
      (a) =>
        `<li><span class="atype">${esc(a.type)}</span> ${esc(a.summary)}${
          a.reasoning ? `<div class="reason">🤖 ${esc(a.reasoning)}</div>` : ""
        }<span class="ago">${esc(new Date(a.createdAt).toLocaleTimeString())}</span></li>`
    )
    .join("");

  const m = snap.metrics || {};

  const incidentRows = (snap.incidents || [])
    .map((i) =>
      row([esc(i.incidentNumber), esc(i.title), esc(i.medicine?.medicineName || "—"), pill(i.status)])
    )
    .join("");

  const workflowRows = (snap.workflows || [])
    .map((w) => {
      const done = (w.steps || []).filter((s) => s.status === "done").length;
      const total = (w.steps || []).length;
      return row([
        esc(w.workflowNumber),
        esc(w.type),
        `${done}/${total} steps`,
        pill(w.status),
      ]);
    })
    .join("");

  const caseRows = (snap.cases || [])
    .map((k) =>
      row([esc(k.caseNumber), esc(k.title), esc(k.subject?.name || "self"), pill(k.status)])
    )
    .join("");

  const taskRows = (snap.tasks || [])
    .map((t) => row([esc(t.taskNumber), esc(t.title), esc(t.type), pill(t.status)]))
    .join("");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>MediFast CareOps — Operations</title>
<meta http-equiv="refresh" content="8"/>
<style>
  :root{font-family:-apple-system,Segoe UI,Roboto,sans-serif}
  body{margin:0;background:#0f172a;color:#e2e8f0}
  header{padding:18px 24px;background:#111827;border-bottom:1px solid #1f2937;display:flex;align-items:center;justify-content:space-between}
  header h1{font-size:18px;margin:0}
  .mode{font-size:12px;padding:4px 10px;border-radius:999px;background:#1e293b;color:#93c5fd}
  .grid{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;padding:16px 24px}
  .metric{background:#111827;border:1px solid #1f2937;border-radius:12px;padding:16px;text-align:center}
  .metric-value{font-size:30px;font-weight:700}
  .metric-label{font-size:12px;color:#94a3b8;margin-top:4px}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:0 24px 24px}
  .panel{background:#111827;border:1px solid #1f2937;border-radius:12px;padding:14px}
  .panel h2{font-size:14px;margin:0 0 10px;color:#cbd5e1}
  table{width:100%;border-collapse:collapse;font-size:13px}
  td{padding:6px 8px;border-bottom:1px solid #1f2937}
  .pill{font-size:11px;padding:2px 8px;border-radius:999px;color:#0b1220;font-weight:700}
  ul.actions{list-style:none;margin:0;padding:0;max-height:340px;overflow:auto}
  ul.actions li{padding:7px 4px;border-bottom:1px solid #1f2937;font-size:13px}
  .atype{display:inline-block;min-width:120px;color:#60a5fa;font-weight:600}
  .ago{float:right;color:#64748b;font-size:11px}
  .reason{color:#94a3b8;font-size:12px;font-style:italic;margin:2px 0 0 4px}
  .kpi-bar{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;padding:0 24px 8px}
  .kpi{background:#0b1220;border:1px solid #1f2937;border-radius:10px;padding:12px;text-align:center}
  .kpi-v{display:block;font-size:22px;font-weight:700}
  .kpi-l{display:block;font-size:11px;color:#94a3b8;margin-top:2px}
  .breach-banner{margin:0 24px 8px;padding:10px 14px;background:#3b1116;border:1px solid #7f1d1d;border-radius:10px;color:#fecaca;font-size:13px}
  footer{padding:10px 24px;color:#64748b;font-size:12px}
</style></head>
<body>
<header>
  <h1>🩺 MediFast CareOps — Autonomous Healthcare Operations</h1>
  <span class="mode">ServiceNow: ${esc(snHealth.mode || "mock")}</span>
</header>
<div class="grid">
  ${card("Open Cases", c.openCases || 0, "#60a5fa")}
  ${card("Open Tasks", c.openTasks || 0, "#a78bfa")}
  ${card("Open Incidents", c.openIncidents || 0, "#f87171")}
  ${card("Active Workflows", c.openWorkflows || 0, "#fbbf24")}
  ${card("Escalations", c.escalations || 0, "#fb7185")}
</div>
<div class="kpi-bar">
  <div class="kpi"><span class="kpi-v" style="color:#34d399">${m.slaCompliancePct ?? 100}%</span><span class="kpi-l">SLA Compliance</span></div>
  <div class="kpi"><span class="kpi-v" style="color:#38bdf8">${m.mttrMinutes ?? 0}m</span><span class="kpi-l">Mean Time To Resolve</span></div>
  <div class="kpi"><span class="kpi-v" style="color:#a78bfa">${m.incidentResolutionRate ?? 0}%</span><span class="kpi-l">Incident Resolution</span></div>
  <div class="kpi"><span class="kpi-v" style="color:#fbbf24">${m.workflowCompletionRate ?? 0}%</span><span class="kpi-l">Workflow Completion</span></div>
  <div class="kpi"><span class="kpi-v" style="color:#fb7185">${m.slaBreaches ?? 0}</span><span class="kpi-l">SLA Breaches</span></div>
</div>
${
  (m.slaBreaches ?? 0) > 0
    ? `<div class="breach-banner">⚠️ ${m.slaBreaches} SLA breach detected → <b>auto-escalated</b> to the SOS pharmacy network for human sourcing.</div>`
    : ""
}
<div class="cols">
  <div class="panel">
    <h2>⚙️ Workflows</h2>
    <table>${workflowRows || row(["—", "no workflows yet", "", ""])}</table>
    <h2 style="margin-top:16px">🚨 Incidents</h2>
    <table>${incidentRows || row(["—", "no incidents", "", ""])}</table>
  </div>
  <div class="panel">
    <h2>🤖 Recent Agent Actions</h2>
    <ul class="actions">${actions || "<li>No actions yet — run a search in the bot.</li>"}</ul>
  </div>
</div>
<div class="cols">
  <div class="panel">
    <h2>📂 Cases</h2>
    <table>${caseRows || row(["—", "no cases", "", ""])}</table>
  </div>
  <div class="panel">
    <h2>🧩 Tasks</h2>
    <table>${taskRows || row(["—", "no tasks", "", ""])}</table>
  </div>
</div>
<footer>Auto-refreshes every 8s · generated ${esc(snap.generatedAt || "")}</footer>
</body></html>`;
};

module.exports = { renderDashboardHtml };
