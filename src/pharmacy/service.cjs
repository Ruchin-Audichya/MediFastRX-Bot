const directory = require("../../data/jaipur-directory.json");
const areas = {
  jaipur: [26.9124, 75.7873],
  mansarovar: [26.854, 75.762],
  "vaishali nagar": [26.911, 75.744],
  "malviya nagar": [26.854, 75.813],
  "c scheme": [26.907, 75.799],
  "raja park": [26.895, 75.83],
  "tonk road": [26.865, 75.798],
};
function distanceKm(a, b) {
  const r = (x) => (x * Math.PI) / 180;
  const h =
    Math.sin(r(b.lat - a.lat) / 2) ** 2 +
    Math.cos(r(a.lat)) *
      Math.cos(r(b.lat)) *
      Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
function location(input = {}) {
  if (input.lat !== undefined || input.lng !== undefined) {
    const lat = Number(input.lat),
      lng = Number(input.lng);
    if (
      input.lat === "" ||
      input.lng === "" ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    )
      throw Error("Use valid latitude and longitude.");
    return { lat, lng, label: "Your selected location" };
  }
  const key =
    String(input.area || "Jaipur")
      .toLowerCase()
      .replace(/-/g, " ")
      .replace(/,?\s*jaipur$/, "")
      .trim() || "jaipur";
  if (!areas[key])
    throw Error("Choose a location result first, or use browser location.");
  return {
    lat: areas[key][0],
    lng: areas[key][1],
    label:
      key === "jaipur"
        ? "Jaipur"
        : `${key.replace(/\b\w/g, (c) => c.toUpperCase())}, Jaipur`,
  };
}
function phoneNumber(raw) {
  return typeof raw === "string" &&
    /^\+?[\d ()-]{7,24}$/.test(raw) &&
    raw.replace(/\D/g, "").length >= 7
    ? raw
    : null;
}
async function jsonFetch(fetchImpl, url, timeout = 5000) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const r = await fetchImpl(url, {
          signal: controller.signal,
          headers: {
            "User-Agent": "MediFast/2.0 local-pharmacy-reference",
            Accept: "application/json",
          },
        });
        if (!r.ok) throw Error("Directory unavailable");
        return r.json();
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(Error("Directory timeout"));
        }, timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
function boundedSet(cache, key, value, max = 64) {
  if (cache.size >= max) cache.delete(cache.keys().next().value);
  cache.set(key, value);
}
function createPharmacyService({
  mode = process.env.PHARMACY_MODE || "live",
  fetchImpl = fetch,
  timeout = 5000,
  snapshots = directory,
} = {}) {
  if (!["demo", "live"].includes(mode))
    throw Error("PHARMACY_MODE must be demo or live.");
  const cache = new Map(),
    placesCache = new Map(),
    pending = new Map();
  async function places(query) {
    if (
      typeof query !== "string" ||
      query.trim().length < 3 ||
      query.length > 100
    )
      throw Error("Enter an area and city (3–100 characters).");
    try {
      return {
        items: [location({ area: query })],
        source: "Included Jaipur area center",
      };
    } catch {}
    const key = query.trim().toLowerCase();
    if (placesCache.has(key)) return placesCache.get(key);
    try {
      const d = await jsonFetch(
        fetchImpl,
        `https://photon.komoot.io/api/?${new URLSearchParams({ q: query, limit: "5", lang: "en" })}`,
        timeout,
      );
      const items = (d.features || [])
        .map((f) => {
          const p = f.properties || {},
            c = f.geometry?.coordinates;
          return c && Number.isFinite(c[0]) && Number.isFinite(c[1])
            ? {
                lat: c[1],
                lng: c[0],
                label: [p.name, p.city || p.district, p.state, p.country]
                  .filter(Boolean)
                  .filter((x, i, a) => a.indexOf(x) === i)
                  .join(", "),
              }
            : null;
        })
        .filter(Boolean);
      const result = { items, source: "Photon · OpenStreetMap" };
      boundedSet(placesCache, key, result);
      return result;
    } catch {
      throw Error(
        "Area search is unavailable. Try a listed Jaipur area or browser location.",
      );
    }
  }
  async function live(center, radius) {
    const d = await jsonFetch(
      fetchImpl,
      `https://photon.komoot.io/reverse?${new URLSearchParams({ lat: center.lat, lon: center.lng, radius, limit: "30", osm_tag: "amenity:pharmacy", lang: "en" })}`,
      timeout,
    );
    let items = (d.features || [])
      .map((f) => {
        const p = f.properties || {},
          c = f.geometry?.coordinates,
          type = { N: "node", W: "way", R: "relation" }[p.osm_type];
        if (
          !c ||
          !type ||
          !Number.isSafeInteger(p.osm_id) ||
          !Number.isFinite(c[0]) ||
          !Number.isFinite(c[1]) ||
          p.osm_value !== "pharmacy"
        )
          return null;
        return {
          id: `${type}/${p.osm_id}`,
          type,
          osmId: p.osm_id,
          name: p.name || "Unnamed pharmacy",
          lat: c[1],
          lng: c[0],
          address:
            [
              p.housenumber,
              p.street,
              p.locality || p.district,
              p.city,
              p.postcode,
            ]
              .filter(Boolean)
              .join(", ") || "Address not listed — use directions",
          phone: null,
          hours: null,
          source: "OpenStreetMap contributors via Photon",
          sourceUrl: `https://www.openstreetmap.org/${type}/${p.osm_id}`,
          sourceKind: "live",
          demo: false,
          stock: "Call to confirm",
          checkedAt: new Date().toISOString(),
        };
      })
      .filter(Boolean)
      .filter((p) => distanceKm(center, p) <= radius)
      .slice(0, 24);
    // Fetch only the returned public OSM objects, in at most three small batches.
    await Promise.all(
      ["node", "way", "relation"].map(async (type) => {
        const group = items.filter((p) => p.type === type);
        if (!group.length) return;
        try {
          const details = await jsonFetch(
            fetchImpl,
            `https://api.openstreetmap.org/api/0.6/${type}s.json?${type}s=${group.map((p) => p.osmId).join(",")}`,
            Math.min(timeout, 3000),
          );
          for (const e of details.elements || []) {
            const p = group.find((p) => p.osmId === e.id),
              t = e.tags || {};
            if (!p) continue;
            p.phone = phoneNumber(t.phone || t["contact:phone"]);
            p.hours =
              typeof t.opening_hours === "string"
                ? t.opening_hours.slice(0, 200)
                : null;
            p.updatedAt = e.timestamp || null;
            p.contactChecked = true;
            if (t["addr:full"]) p.address = t["addr:full"];
          }
        } catch {
          /* Keep the list useful when contact enrichment is unavailable. */
        }
      }),
    );
    return items;
  }
  async function search(input = {}) {
    const center = location(input),
      radius = Number(input.radius || 5);
    if (![2, 5, 10].includes(radius))
      throw Error("Choose a 2, 5 or 10 km radius.");
    if (mode === "demo")
      return {
        mode,
        center,
        radius,
        notice:
          "Illustrative Jaipur listings, not real businesses. No contact or inventory data.",
        items: [
          {
            id: "sample1",
            name: "The neighbourhood pharmacy",
            address: "Example location · near MI Road, Jaipur",
            lat: 26.917,
            lng: 75.795,
          },
          {
            id: "sample2",
            name: "A pharmacy around the corner",
            address: "Example location · C-Scheme, Jaipur",
            lat: 26.907,
            lng: 75.799,
          },
          {
            id: "sample3",
            name: "Your local medical store",
            address: "Example location · Raja Park, Jaipur",
            lat: 26.895,
            lng: 75.83,
          },
        ]
          .map((p) => ({
            ...p,
            phone: null,
            hours: null,
            demo: true,
            sourceKind: "demo",
            source: "Sample listing",
            stock: "Call to confirm",
            distanceKm: distanceKm(center, p),
          }))
          .sort((a, b) => a.distanceKm - b.distanceKm),
      };
    const key = `${center.lat.toFixed(3)},${center.lng.toFixed(3)},${radius}`,
      cached = cache.get(key);
    let online = [],
      unavailable = false,
      fromCache = false;
    if (cached && Date.now() - cached.at < 300000) {
      online = cached.items;
      fromCache = true;
      unavailable = cached.unavailable;
    } else {
      try {
        if (!pending.has(key))
          pending.set(
            key,
            live(center, radius).finally(() => pending.delete(key)),
          );
        online = await pending.get(key);
        boundedSet(cache, key, {
          at: Date.now(),
          items: online,
          unavailable: false,
        });
      } catch {
        unavailable = true;
        boundedSet(cache, key, {
          at: Date.now() - 270000,
          items: [],
          unavailable: true,
        });
      }
    }
    const saved = snapshots
      .map((p) => ({
        ...p,
        sourceKind: "directory",
        demo: false,
        stock: "Call to confirm",
      }))
      .filter((p) => distanceKm(center, p) <= radius);
    const items = [...online];
    for (const p of saved) {
      const match = items.find(
        (x) =>
          (x.phone &&
            x.phone.replace(/\D/g, "") === p.phone.replace(/\D/g, "")) ||
          (distanceKm(x, p) < 0.15 && /apollo/i.test(x.name)),
      );
      if (!match) items.push(p);
      else if (!match.phone) {
        match.phone = p.phone;
        match.contactSourceUrl = p.sourceUrl;
        match.contactCheckedAt = p.checkedAt;
      }
    }
    return {
      mode,
      center,
      radius,
      unavailable,
      cached: fromCache,
      items: items
        .map((p) => ({ ...p, distanceKm: distanceKm(center, p) }))
        .filter((p) => p.distanceKm <= radius)
        .sort((a, b) => a.distanceKm - b.distanceKm),
      notice: unavailable
        ? "Live map search is unavailable. Any results below are dated source records or local shop uploads."
        : "Map listings are fetched online. Published directory contacts and shop uploads have separate labels. Call to confirm stock.",
    };
  }
  return { search, places, mode };
}
module.exports = { createPharmacyService, location, distanceKm, phoneNumber };
