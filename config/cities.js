const cities = {
  Jaipur: {
    name: "Jaipur",
    state: "Rajasthan",
    country: "India",
    lat: 26.9124,
    lng: 75.7873,
    radiusKm: 25,
  },
  Delhi: {
    name: "Delhi",
    state: "Delhi",
    country: "India",
    lat: 28.6139,
    lng: 77.209,
    radiusKm: 30,
  },
  Mumbai: {
    name: "Mumbai",
    state: "Maharashtra",
    country: "India",
    lat: 19.076,
    lng: 72.8777,
    radiusKm: 35,
  },
  Kota: {
    name: "Kota",
    state: "Rajasthan",
    country: "India",
    lat: 25.2138,
    lng: 75.8648,
    radiusKm: 20,
  },
  Bengaluru: {
    name: "Bengaluru",
    state: "Karnataka",
    country: "India",
    lat: 12.9716,
    lng: 77.5946,
    radiusKm: 30,
  },
  Hyderabad: {
    name: "Hyderabad",
    state: "Telangana",
    country: "India",
    lat: 17.385,
    lng: 78.4867,
    radiusKm: 30,
  },
  Chennai: {
    name: "Chennai",
    state: "Tamil Nadu",
    country: "India",
    lat: 13.0827,
    lng: 80.2707,
    radiusKm: 30,
  },
  Kolkata: {
    name: "Kolkata",
    state: "West Bengal",
    country: "India",
    lat: 22.5726,
    lng: 88.3639,
    radiusKm: 25,
  },
  Pune: {
    name: "Pune",
    state: "Maharashtra",
    country: "India",
    lat: 18.5204,
    lng: 73.8567,
    radiusKm: 25,
  },
  Ahmedabad: {
    name: "Ahmedabad",
    state: "Gujarat",
    country: "India",
    lat: 23.0225,
    lng: 72.5714,
    radiusKm: 25,
  },
  Lucknow: {
    name: "Lucknow",
    state: "Uttar Pradesh",
    country: "India",
    lat: 26.8467,
    lng: 80.9462,
    radiusKm: 25,
  },
  Indore: {
    name: "Indore",
    state: "Madhya Pradesh",
    country: "India",
    lat: 22.7196,
    lng: 75.8577,
    radiusKm: 20,
  },
  Chandigarh: {
    name: "Chandigarh",
    state: "Chandigarh",
    country: "India",
    lat: 30.7333,
    lng: 76.7794,
    radiusKm: 20,
  },
};

const getCityConfig = (cityName = "Jaipur") => {
  const match = Object.values(cities).find((city) => city.name.toLowerCase() === String(cityName).toLowerCase());
  return match || cities.Jaipur;
};

// Self-contained haversine distance (km) between two lat/lng points.
// Inlined here (rather than importing from pharmacyLocationService.js) to avoid
// a future circular dependency: pharmacyLocationService.js may import cities.js.
const haversineKm = (aLat, aLng, bLat, bLng) => {
  const toRad = (value) => (value * Math.PI) / 180;
  const earthKm = 6371;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return earthKm * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};

const isValidLatLng = (lat, lng) =>
  Number.isFinite(lat) &&
  Number.isFinite(lng) &&
  lat >= -90 &&
  lat <= 90 &&
  lng >= -180 &&
  lng <= 180;

/**
 * Pick the configured city whose centroid is closest to the given coordinates.
 *
 * Returns the city object augmented with `distanceKm` (haversine to its centroid).
 * Falls back to the same default as `getCityConfig` (Jaipur) when input is invalid.
 *
 * @param {{ latitude: number, longitude: number, maxDistanceKm?: number }} input
 * @returns {(typeof cities)[keyof typeof cities] & { distanceKm: number } | null}
 */
const getNearestCity = ({ latitude, longitude, maxDistanceKm } = {}) => {
  const lat = Number(latitude);
  const lng = Number(longitude);

  if (!isValidLatLng(lat, lng)) {
    // Mirror getCityConfig's fallback so callers get a stable default.
    return { ...cities.Jaipur, distanceKm: Number.POSITIVE_INFINITY };
  }

  let nearest = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const city of Object.values(cities)) {
    const distanceKm = haversineKm(lat, lng, city.lat, city.lng);
    if (distanceKm < nearestDistance) {
      nearestDistance = distanceKm;
      nearest = city;
    }
  }

  if (!nearest) {
    return { ...cities.Jaipur, distanceKm: Number.POSITIVE_INFINITY };
  }

  if (Number.isFinite(maxDistanceKm) && nearestDistance > maxDistanceKm) {
    return null;
  }

  return { ...nearest, distanceKm: nearestDistance };
};

module.exports = {
  cities,
  getCityConfig,
  getNearestCity,
};
