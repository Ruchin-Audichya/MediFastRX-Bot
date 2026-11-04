import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

export type MapPin = { id: string | number; lat: number; lng: number; state: string; title: string; label?: string; big?: boolean; pulse?: boolean };

/**
 * Leaflet map with CARTO Positron tiles. Pins are coloured by answer state using the same
 * .s-* classes as the rest of the product. Tiles are optional: if they fail, pins still show.
 */
export function MapView({ pins, you, radiusKm, className, fit = true, onPin }: { pins: MapPin[]; you?: { lat: number; lng: number } | null; radiusKm?: number; className?: string; fit?: boolean; onPin?: (id: MapPin["id"]) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const fitted = useRef("");

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current, { zoomControl: false, attributionControl: true, scrollWheelZoom: false }).setView([26.9, 75.78], 12);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 19, subdomains: "abcd",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
    }).addTo(m);
    L.control.zoom({ position: "bottomright" }).addTo(m);
    layer.current = L.layerGroup().addTo(m);
    map.current = m;
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(el.current);
    return () => { ro.disconnect(); m.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    const m = map.current, g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    if (you) {
      if (radiusKm) L.circle([you.lat, you.lng], { radius: radiusKm * 1000, color: "#12a46b", weight: 1.5, fillColor: "#12a46b", fillOpacity: 0.06, dashArray: "4 6" }).addTo(g);
      L.marker([you.lat, you.lng], { icon: L.divIcon({ className: "", html: '<div class="mf-you"></div>', iconSize: [18, 18] }), keyboard: false, interactive: false }).addTo(g);
    }
    for (const p of pins) {
      const html = `<div class="mf-pin s-${p.state}${p.big ? " big" : ""}${p.pulse ? " pulse" : ""}"></div>`;
      const mk = L.marker([p.lat, p.lng], { icon: L.divIcon({ className: "", html, iconSize: [22, 22] }), title: p.title, riseOnHover: true }).addTo(g);
      mk.bindTooltip(p.label ?? p.title, { direction: "top", offset: [0, -10] });
      if (onPin) mk.on("click", () => onPin(p.id));
    }
    const key = JSON.stringify([you?.lat, you?.lng, radiusKm, pins.length]);
    if (fit && key !== fitted.current) {
      fitted.current = key;
      if (you && radiusKm) m.fitBounds(L.latLng(you.lat, you.lng).toBounds(radiusKm * 2000 + 400), { padding: [16, 16] });
      else if (pins.length) m.fitBounds(L.latLngBounds(pins.map((p) => [p.lat, p.lng] as [number, number])), { padding: [28, 28], maxZoom: 14 });
    }
  }, [pins, you, radiusKm, fit, onPin]);

  return <div ref={el} className={className ?? "map"} role="region" aria-label="Map of participating pharmacies" />;
}
