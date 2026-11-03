import React from "react";
import { MapContainer, TileLayer, CircleMarker, Popup } from "react-leaflet";
export default function PartnerMap({
  center,
  items,
}: {
  center: { lat: number; lng: number };
  items: any[];
}) {
  return (
    <div className="partner-map">
      <MapContainer
        key={`${center.lat},${center.lng}`}
        center={[center.lat, center.lng]}
        zoom={13}
        scrollWheelZoom={false}
        style={{ height: 330, width: "100%" }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <CircleMarker
          center={[center.lat, center.lng]}
          radius={7}
          pathOptions={{ color: "#d76c3b" }}
        >
          <Popup>Your search location</Popup>
        </CircleMarker>
        {items.map((p) => (
          <CircleMarker
            key={p.id}
            center={[p.lat, p.lng]}
            radius={10}
            pathOptions={{ color: "#195448" }}
          >
            <Popup>
              <strong>{p.name}</strong>
              <p>{p.demo ? "Fictional demo location" : p.address}</p>
            </Popup>
          </CircleMarker>
        ))}
      </MapContainer>
      <p className="small muted">
        If map tiles are unavailable, the list and directions still work. Demo
        markers are illustrative.
      </p>
    </div>
  );
}
