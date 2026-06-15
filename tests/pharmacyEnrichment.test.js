const test = require("node:test");
const assert = require("node:assert/strict");
const { openStatusFor, rankPharmacies } = require("../src/pharmacy/pharmacyRankingService");
const { formatNearbyRecommendations } = require("../src/bot/commands/nearby");

test("pharmacy ranking includes open status, popularity, and search success", () => {
  const ranked = rankPharmacies({
    pharmacies: [
      {
        _id: "p1",
        name: "Popular Medicos",
        address: "MI Road",
        location: { type: "Point", coordinates: [75.7874, 26.9125] },
        inventory: ["Dolo 650"],
        confidence: 0.8,
        openingHours: "9:00 AM - 10:00 PM",
      },
    ],
    userLocation: { latitude: 26.9124, longitude: 75.7873 },
    radiusKm: 5,
    medicineQuery: "Dolo",
    popularityByPharmacy: new Map([["Popular Medicos", 0.9]]),
    successByPharmacy: new Map([["Popular Medicos", 0.8]]),
  });

  assert.equal(ranked[0].inventoryConfidence, 1);
  assert.equal(ranked[0].popularityScore, 0.9);
  assert.equal(ranked[0].searchSuccessScore, 0.8);
  assert.match(ranked[0].openStatus, /open|closed|9:00/i);
});

test("nearby formatter shows enriched pharmacy intelligence", () => {
  const message = formatNearbyRecommendations(
    {
      radiusKm: 5,
      medicineConfidence: 0.88,
      ranked: [
        {
          name: "Popular Medicos",
          address: "MI Road",
          distance: "200 m",
          score: 0.93,
          inventoryConfidence: 0.82,
          popularityScore: 0.9,
          searchSuccessScore: 0.8,
          openStatus: "Likely open now",
          inventoryMatches: [],
          phone: "9999999999",
        },
      ],
    },
    "Dolo"
  );

  assert.match(message, /🟢 Open|⏰/);
  assert.match(message, /Popular Medicos/);
  assert.match(message, /Dolo/);
});

test("open status parser handles 24x7 pharmacies", () => {
  assert.equal(openStatusFor({ is24x7: true }).label, "Open 24x7");
});
