"use strict";

// /careops — judge-facing operations summary inside Telegram. Renders the live
// CareOps snapshot (open cases/tasks/incidents/workflows + recent agent
// actions) so the autonomous "operations agent" story is visible without
// leaving the chat. Reuses careOpsService.getDashboardSnapshot.

const { getDashboardSnapshot } = require("../../careops/careOpsService");
const { escapeHtml } = require("../../utils/formatter");
const logger = require("../../utils/logger");

const ACTION_ICON = {
  case_opened: "📂",
  case_updated: "📂",
  case_resolved: "✅",
  task_created: "🧩",
  task_completed: "✅",
  incident_opened: "🚨",
  incident_resolved: "✅",
  workflow_started: "⚙️",
  workflow_step: "➡️",
  workflow_resolved: "🏁",
  escalation: "⏫",
  servicenow_sync: "🔗",
  note: "📝",
};

const handleCareOpsSummary = async (ctx) => {
  try {
    const snap = await getDashboardSnapshot();
    const c = snap.counts;
    const m = snap.metrics || {};

    const lines = [];
    lines.push("🩺 <b>MediFast CareOps — Operations</b>");
    lines.push("");
    lines.push(`📂 Open cases: <b>${c.openCases}</b>`);
    lines.push(`🧩 Open tasks: <b>${c.openTasks}</b>`);
    lines.push(`🚨 Open incidents: <b>${c.openIncidents}</b>`);
    lines.push(`⚙️ Active workflows: <b>${c.openWorkflows}</b>`);
    lines.push(`⏫ Escalations: <b>${c.escalations}</b>`);
    lines.push("");
    lines.push("<b>Operational KPIs</b>");
    lines.push(`✅ SLA compliance: <b>${m.slaCompliancePct ?? 100}%</b>`);
    lines.push(`⏱ MTTR: <b>${m.mttrMinutes ?? 0} min</b>`);
    lines.push(`📈 Incident resolution: <b>${m.incidentResolutionRate ?? 0}%</b>`);
    if ((m.slaBreaches ?? 0) > 0) {
      lines.push(`⚠️ <b>${m.slaBreaches}</b> SLA breach → auto-escalated to SOS network`);
    }

    if (snap.recentActions.length) {
      lines.push("");
      lines.push("<b>Recent agent actions</b>");
      lines.push("<blockquote expandable>");
      for (const a of snap.recentActions.slice(0, 12)) {
        const icon = ACTION_ICON[a.type] || "•";
        lines.push(`${icon} ${escapeHtml(a.summary)}`);
      }
      lines.push("</blockquote>");
    }

    lines.push("");
    lines.push("<i>Autonomous healthcare operations — every search becomes a tracked workflow.</i>");

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  } catch (error) {
    logger.error(`careops summary error: ${error.message}`);
    await ctx.reply("⚠️ CareOps summary is unavailable right now.");
  }
};

module.exports = { handleCareOpsSummary };
