import dynamic from "next/dynamic";
const DirectoryMap = dynamic(() => import("./PartnerMap"), { ssr: false });
import React, { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  MapPin,
  Navigation,
  Pill,
  Search,
  LocateFixed,
  LoaderCircle,
  Clock,
  Phone,
  ExternalLink,
} from "lucide-react";
import { api, signature } from "./lib.js";
export default function Pharmacies({ medicine, mode, back }) {
  const [area, setArea] = useState("Jaipur"),
    [data, setData] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [geo, setGeo] = useState(false),
    [places, setPlaces] = useState([]),
    [radius, setRadius] = useState("5"),
    [filter, setFilter] = useState("all"),
    [copied, setCopied] = useState(false),
    [showMap, setShowMap] = useState(false);
  const req = useRef(null),
    version = useRef(0),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      version.current++;
      req.current?.abort();
    };
  }, []);
  async function search(params) {
    const v = ++version.current;
    req.current?.abort();
    const controller = new AbortController();
    req.current = controller;
    setBusy(true);
    setData(null);
    setPlaces([]);
    setError("");
    try {
      const d = await api(
        `/api/pharmacies?${new URLSearchParams({ ...params, radius, ...(medicine ? { medicineId: medicine.id } : {}) })}`,
        {
          signal: controller.signal,
        },
      );
      if (v === version.current) setData(d);
    } catch (e) {
      if (e.name !== "AbortError" && v === version.current) setError(e.message);
    } finally {
      if (v === version.current) setBusy(false);
    }
  }
  async function findArea() {
    const v = ++version.current;
    req.current?.abort();
    const controller = new AbortController();
    req.current = controller;
    setBusy(true);
    setError("");
    setPlaces([]);
    setData(null);
    try {
      const result = await api(`/api/places?q=${encodeURIComponent(area)}`, {
        signal: controller.signal,
      });
      if (v !== version.current) return;
      if (result.items.length === 1) await search(result.items[0]);
      else {
        setPlaces(result.items);
        if (!result.items.length)
          setError(
            "No area found. Include a city name or use browser location.",
          );
      }
    } catch (e) {
      if (e.name !== "AbortError" && v === version.current) setError(e.message);
    } finally {
      if (v === version.current) setBusy(false);
    }
  }
  async function copyBrief() {
    try {
      await navigator.clipboard.writeText(
        `Hello, do you have ${medicine.name} ${medicine.strength || ""} ${medicine.form || ""}? Please confirm the exact brand, strength, formulation, pack size and price before I visit.`,
      );
      setCopied(true);
    } catch {
      setError(
        "Copy is unavailable. You can select the call brief text below.",
      );
    }
  }
  function locate() {
    if (!navigator.geolocation) {
      setError("Location is not supported here. Choose an area below.");
      return;
    }
    setGeo(true);
    setError("");
    navigator.geolocation.getCurrentPosition(
      (p) => {
        if (!mounted.current) return;
        setGeo(false);
        search({ lat: p.coords.latitude, lng: p.coords.longitude });
      },
      () => {
        if (!mounted.current) return;
        setGeo(false);
        setError(
          "Location wasn’t shared. No problem — search an area and city below.",
        );
      },
      { timeout: 8000, maximumAge: 60000 },
    );
  }
  const center = data?.center;
  const items = (data?.items || []).filter((p) =>
    filter === "phone" ? !!p.phone && !p.demo : true,
  );
  const sourceLabel = (p) =>
    p.sourceKind === "shop"
      ? p.demo
        ? "PRACTICE SHOP"
        : "SHOP UPLOAD"
      : p.sourceKind === "directory"
        ? "PUBLISHED DIRECTORY"
        : p.demo
          ? "SAMPLE LISTING"
          : "LIVE MAP LISTING";
  return (
    <section className="pharmacy-screen">
      <button className="text-button back" onClick={back}>
        <ArrowLeft size={16} />
        Back to {medicine?.name || "search"}
      </button>
      <p className="eyebrow">A CLEARER NEXT STEP</p>
      <div className="page-title">
        <div>
          <h1>
            Find your pack.
            <br />
            <em>Closer to home.</em>
          </h1>
          <p>Call before you head out. Nearby doesn’t mean in stock.</p>
        </div>
        <div className="location-art" aria-hidden="true">
          <MapPin size={72} strokeWidth={1.2} />
          <span>around your corner</span>
        </div>
      </div>
      {medicine && (
        <div className="context-label pharmacy-context">
          <Pill size={16} />
          Looking for {medicine.name} · {signature(medicine)}
          <span>No inventory verified</span>
        </div>
      )}
      <div className="location-panel">
        <div>
          <h2>Around where?</h2>
          <p>
            {mode === "demo"
              ? "Explore sample Jaipur listings. No real businesses or phone numbers."
              : "Search an area or share your location. Start with Jaipur, or try your own city."}
          </p>
        </div>
        <div className="location-controls">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              findArea();
            }}
          >
            <label className="sr-only" htmlFor="area">
              Area or location
            </label>
            <MapPin size={18} />
            <input
              id="area"
              list="areas"
              value={area}
              onChange={(e) => setArea(e.target.value)}
              placeholder="Try Mansarovar, Jaipur"
              maxLength={80}
            />
            <datalist id="areas">
              {[
                "Jaipur",
                "Mansarovar",
                "Vaishali Nagar",
                "Malviya Nagar",
                "C-Scheme",
                "Raja Park",
                "Tonk Road",
              ].map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
            <button className="primary" disabled={busy || geo}>
              {busy ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <Search size={17} />
              )}
              Find
            </button>
          </form>
          <button className="secondary" onClick={locate} disabled={geo || busy}>
            <LocateFixed size={17} />
            {geo ? "Locating…" : "Use my location"}
          </button>
        </div>
        <p className="small muted">
          Location is requested only when you tap the button.{" "}
          {mode === "live"
            ? "Location is sent to Photon/OpenStreetMap for this search; it is not saved to your shelf."
            : "Demo results remain illustrative Jaipur locations."}
        </p>
      </div>
      <div className="finder-tools">
        <label>
          Search radius{" "}
          <select
            aria-label="Search radius"
            value={radius}
            onChange={(e) => {
              setRadius(e.target.value);
              setData(null);
            }}
          >
            <option value="2">2 km</option>
            <option value="5">5 km</option>
            <option value="10">10 km</option>
          </select>
        </label>
        <span className="small muted">
          Straight-line distances, not driving distances.
        </span>
      </div>
      {places.length > 0 && (
        <div className="place-choices">
          <h2>Which location did you mean?</h2>
          {places.map((p, i) => (
            <button className="secondary" key={i} onClick={() => search(p)}>
              <MapPin size={16} />
              {p.label}
            </button>
          ))}
        </div>
      )}
      {medicine && (
        <details className="call-brief">
          <summary>
            Your ready-to-use call brief <Pill size={16} />
          </summary>
          <p>
            Hello, do you have{" "}
            <strong>
              {medicine.name} · {signature(medicine)}
            </strong>
            ? Please confirm the exact brand, strength, formulation, pack size
            and price before I visit.
          </p>
          <button className="secondary" onClick={copyBrief}>
            {copied ? "Copied — ready for your call" : "Copy call brief"}
          </button>
        </details>
      )}
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {busy && (
        <div className="loading-state" role="status">
          <LoaderCircle className="spin" />
          Finding places to contact…
        </div>
      )}
      {data && (
        <>
          <div className="section-top results-title">
            <h2>
              {data.mode === "demo"
                ? "A preview of nearby listings"
                : `Around ${center.label}`}
            </h2>
            <span className="tag">
              {data.mode === "demo" ? "SAMPLE RESULTS" : "NEARBY DIRECTORY"}
            </span>
          </div>
          <div className="notice">{data.notice}</div>
          <button className="text-button" onClick={() => setShowMap(!showMap)}>
            {showMap ? "Hide map" : "Show nearby map"}
          </button>
          {showMap && <DirectoryMap center={center} items={data.items} />}
          <div className="result-filters" aria-label="Filter pharmacies">
            {[
              ["all", "All nearby"],
              ["phone", "With phone"],
            ].map(([key, label]) => (
              <button
                key={key}
                className={filter === key ? "selected" : ""}
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
              >
                {label}
              </button>
            ))}
            <span>{items.length} listings</span>
          </div>
          {data.unavailable && !items.length ? (
            <div className="empty-state">
              <h2>No directory connection right now.</h2>
              <p>You can retry or continue with a map search.</p>
              <button
                className="secondary"
                onClick={() => search({ lat: center.lat, lng: center.lng })}
              >
                Try again
              </button>
            </div>
          ) : !items.length ? (
            <div className="empty-state">
              <h2>No listings found in this area.</h2>
              <p>
                Try another filter, increase the radius, or open the map search.
              </p>
            </div>
          ) : (
            <div className="pharmacy-grid">
              {items.map((p, i) => (
                <article className="pharmacy-card" key={p.id}>
                  <div className="section-top">
                    <span
                      className={`listing-source ${p.sourceKind || "live"}`}
                    >
                      {sourceLabel(p)}
                    </span>
                    <span className="distance">
                      {p.distanceKm.toFixed(1)} km
                      {p.demo ? " · illustrative" : ""}
                    </span>
                  </div>
                  <h3>{p.name}</h3>
                  <p className="address">
                    <MapPin size={15} />
                    {p.address}
                  </p>
                  <div className="pharmacy-meta">
                    <span>
                      <Clock size={14} />
                      {p.hours
                        ? `Listed hours: ${p.hours} (unverified)`
                        : "Hours not supplied"}
                    </span>
                    <span>
                      <Phone size={14} />
                      {p.phone || "Contact not supplied"}
                    </span>
                  </div>
                  <span className="stock-label">
                    Call to confirm · stock unknown
                  </span>
                  <div className="pharmacy-actions">
                    {p.phone && !p.demo ? (
                      <a
                        className="primary"
                        href={`tel:${p.phone.replace(/[^+\d]/g, "")}`}
                      >
                        <Phone size={16} />
                        Call pharmacy
                      </a>
                    ) : (
                      <span className="disabled-action">
                        {p.demo ? "Sample · no phone" : "No phone listed"}
                      </span>
                    )}
                    {!p.demo && (
                      <a
                        className="secondary"
                        href={`https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <Navigation size={16} />
                        Directions
                      </a>
                    )}
                  </div>
                  <p className="small muted">
                    {p.sourceUrl ? (
                      <a href={p.sourceUrl} target="_blank" rel="noreferrer">
                        {p.source}
                        <ExternalLink size={12} />
                      </a>
                    ) : (
                      p.source
                    )}
                    {p.demo ? " · Not a real business" : ""}
                    {p.checkedAt && (
                      <span className="source-date">
                        {p.sourceKind === "directory"
                          ? "Source checked"
                          : p.sourceKind === "shop"
                            ? "Uploaded"
                            : "Retrieved"}{" "}
                        {new Date(p.checkedAt).toLocaleDateString()}
                      </span>
                    )}
                    {p.updatedAt && (
                      <span className="source-date">
                        Map record edited{" "}
                        {new Date(p.updatedAt).toLocaleDateString()}
                      </span>
                    )}
                    {p.contactSourceUrl && (
                      <a
                        href={p.contactSourceUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Phone from dated directory record
                      </a>
                    )}
                  </p>
                </article>
              ))}
            </div>
          )}
          <a
            className="map-link"
            target="_blank"
            rel="noreferrer"
            href={`https://www.google.com/maps/search/pharmacy/@${center.lat},${center.lng},14z`}
          >
            <Navigation size={18} />
            {data.mode === "demo"
              ? "Find real pharmacies on a map"
              : "Explore this area on a map"}
            <ArrowUpRight size={17} />
          </a>
        </>
      )}
      {!data && !busy && (
        <div className="pharmacy-before">
          <span className="icon-tile">
            <Navigation size={25} />
          </span>
          <h3>Your location. Your call.</h3>
          <p>
            Pick an area to see listings.
            <br />
            We’ll help you find the next conversation, not guess what’s on the
            shelves.
          </p>
        </div>
      )}
    </section>
  );
}
