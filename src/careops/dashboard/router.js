"use strict";

// CareOps dashboard router. Mounted at /careops by src/server.js.
//   GET /careops            → HTML dashboard (judge view, auto-refreshes)
//   GET /api/careops/summary → JSON snapshot
//   GET /api/careops/health  → CareOps + ServiceNow mode health
// Read-only; no auth (demo surface). Safe because it exposes only operational
// metadata, never PII beyond a telegramId already used elsewhere.

const express = require("express");
const { getDashboardSnapshot } = require("../careOpsService");
const serviceNow = require("../../integrations/servicenow");
const logger = require("../../utils/logger");
const { renderDashboardHtml } = require("./view");

const createCareOpsRouter = () => {
  const router = express.Router();

  router.get("/api/careops/summary", async (req, res) => {
    try {
      const snap = await getDashboardSnapshot();
      res.json(snap);
    } catch (error) {
      logger.error(`careops summary api error: ${error.message}`);
      res.status(500).json({ error: "summary_unavailable" });
    }
  });

  router.get("/api/careops/health", (req, res) => {
    res.json({ careops: "ok", serviceNow: serviceNow.health() });
  });

  // ServiceNow payload preview — proves the integration is real by showing the
  // exact Table API call that would POST for the most recent incident.
  router.get("/api/careops/servicenow-preview", async (req, res) => {
    try {
      const CareIncident = require("../models/CareIncident");
      const latest = await CareIncident.findOne().sort({ createdAt: -1 }).lean();
      if (!latest) {
        return res.json({
          note: "No incidents yet — run npm run demo:careops or trigger a shortage.",
          example: serviceNow.previewPayload("incident", {
            incidentNumber: "INCEXAMPLE",
            title: "Unavailable: Pregabalin",
            priority: "high",
            impact: "high",
            urgency: "high",
            category: "medicine_unavailable",
            medicine: { medicineName: "Pregabalin" },
          }),
        });
      }
      res.json({
        source: { incidentNumber: latest.incidentNumber, status: latest.status },
        servicenow: serviceNow.previewPayload("incident", latest),
      });
    } catch (error) {
      logger.error(`careops servicenow-preview error: ${error.message}`);
      res.status(500).json({ error: "preview_unavailable" });
    }
  });

  router.get("/careops", async (req, res) => {
    try {
      const snap = await getDashboardSnapshot();
      res.set("content-type", "text/html; charset=utf-8");
      res.send(renderDashboardHtml(snap, serviceNow.health()));
    } catch (error) {
      logger.error(`careops dashboard error: ${error.message}`);
      res.status(500).send("<h1>CareOps dashboard unavailable</h1>");
    }
  });

  return router;
};

module.exports = { createCareOpsRouter };
