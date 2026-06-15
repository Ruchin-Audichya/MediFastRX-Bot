const test = require("node:test");
const assert = require("node:assert/strict");
const { extractEntities } = require("../src/ai/entityExtractor");
const { routeMessage } = require("../src/ai/router");
const { formatNearbyRecommendations } = require("../src/bot/commands/nearby");

test("routes medicine near me text to medicine and nearby tools", () => {
  const entities = extractEntities("Dolo near me");
  const routes = routeMessage({ entities });

  assert.equal(entities.nearbyIntent, true);
  assert.equal(routes.some((route) => route.tool === "nearby"), true);
  assert.equal(routes.some((route) => route.tool === "medicine"), true);
});

test("formats nearby pharmacy recommendation response", () => {
  const message = formatNearbyRecommendations(
    {
      radiusKm: 5,
      expandedRadius: false,
      medicine: { genericName: "Paracetamol" },
      ranked: [
        {
          name: "Jaipur Medicos",
          address: "Mansarovar",
          distance: "600 m",
          score: 0.92,
          inventoryConfidence: 1,
          inventoryMatches: [{ medicineName: "Dolo 650 Tablet" }],
          phone: "9999999999",
        },
      ],
    },
    "Dolo"
  );

  assert.match(message, /Jaipur Medicos/);
  assert.match(message, /Paracetamol/);
  assert.match(message, /within 5km/);
});
