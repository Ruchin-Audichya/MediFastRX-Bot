const Pharmacy = require("../models/Pharmacy");
const PharmacySearchHistory = require("../models/PharmacySearchHistory");
const eventBus = require("../events/eventBus");
const { normalizeCoordinates } = require("./pharmacyLocationService");
const { importPharmaciesNearLocation } = require("./sources/sourceManager");
const logger = require("../utils/logger");

const DEFAULT_RADIUS_KM = Number(process.env.NEARBY_RADIUS_KM || 5);
const EXPANDED_RADIUS_KM = Number(process.env.NEARBY_MAX_RADIUS_KM || 10);
const MIN_RESULTS = Number(process.env.NEARBY_MIN_RESULTS || 3);
const LIVE_OSM_LOOKUP = () => process.env.OSM_LIVE_LOOKUP !== "false";

let indexEnsured = false;

const ensurePharmacyGeoIndexes = async () => {
  if (indexEnsured) return;
  await Promise.all([
    Pharmacy.collection.createIndex({ location: "2dsphere" }, { sparse: true }),
    Pharmacy.collection.createIndex({ geoLocation: "2dsphere" }, { sparse: true }),
  ]);
  indexEnsured = true;
};

const geoQuery = ({ latitude, longitude, radiusKm, field = "location" }) => ({
  isActive: true,
  [field]: {
    $nearSphere: {
      $geometry: {
        type: "Point",
        coordinates: [longitude, latitude],
      },
      $maxDistance: radiusKm * 1000,
    },
  },
});

const findWithinRadius = async ({ latitude, longitude, radiusKm }) => {
  await ensurePharmacyGeoIndexes();
  const primary = await Pharmacy.find(geoQuery({ latitude, longitude, radiusKm, field: "location" }))
    .limit(25)
    .lean();
  if (primary.length) return primary;

  return Pharmacy.find(geoQuery({ latitude, longitude, radiusKm, field: "geoLocation" }))
    .limit(25)
    .lean();
};

const searchNearbyPharmacies = async ({ latitude, longitude, radiusKm = DEFAULT_RADIUS_KM, minResults = MIN_RESULTS } = {}) => {
  const location = normalizeCoordinates({ latitude, longitude });
  if (!location) {
    return {
      pharmacies: [],
      radiusKm,
      expandedRadius: false,
      geoReady: false,
    };
  }

  let pharmacies = await findWithinRadius({ ...location, radiusKm });
  let expandedRadius = false;
  if (pharmacies.length < minResults && EXPANDED_RADIUS_KM > radiusKm) {
    pharmacies = await findWithinRadius({ ...location, radiusKm: EXPANDED_RADIUS_KM });
    radiusKm = EXPANDED_RADIUS_KM;
    expandedRadius = true;
  }

  let osmHydrated = false;
  // Hydrate from OSM when we have NO local results, or when the local-DB
  // results are too few even after the expanded radius. This stops the user
  // from seeing the same 1-2 stale seeded pharmacies in a city we don't have
  // good coverage for.
  const needsOsmHydration =
    LIVE_OSM_LOOKUP() && pharmacies.length < minResults;
  if (needsOsmHydration) {
    try {
      const importRadiusKm = Math.max(radiusKm, Number(process.env.OSM_LIVE_RADIUS_KM || radiusKm));
      const summary = await importPharmaciesNearLocation({
        latitude: location.latitude,
        longitude: location.longitude,
        radiusKm: importRadiusKm,
        cityName: "Live Location",
      });
      osmHydrated = summary.importedPharmacyCount > 0 || summary.validRecords > 0;
      if (osmHydrated) {
        pharmacies = await findWithinRadius({ ...location, radiusKm: importRadiusKm });
        radiusKm = importRadiusKm;
      }
    } catch (error) {
      logger.warn(`Live OSM pharmacy lookup skipped: ${error.message}`);
    }
  }

  eventBus.emitSafe("pharmacy.location.search.completed", {
    resultCount: pharmacies.length,
    radiusKm,
    expandedRadius,
    osmHydrated,
  });

  return {
    pharmacies,
    radiusKm,
    expandedRadius,
    osmHydrated,
    geoReady: pharmacies.length > 0,
  };
};

const recordPharmacySearch = async (payload = {}) => {
  try {
    await PharmacySearchHistory.create(payload);
  } catch {
    // Analytics should never block the user flow.
  }
};

module.exports = {
  DEFAULT_RADIUS_KM,
  EXPANDED_RADIUS_KM,
  ensurePharmacyGeoIndexes,
  recordPharmacySearch,
  searchNearbyPharmacies,
};
