import React from "react";
import { driverName } from "../../utils/geoHelpers";
import { type MatchedDriver } from "../../utils/spatialHelpers";
import { type AnalysisMode } from "./index";

interface ControlPanelSpatialProps {
  mode: AnalysisMode;
  setMode: (m: AnalysisMode) => void;
  radiusKm: number;
  setRadiusKm: (r: number) => void;
  nearestK: number;
  setNearestK: (k: number) => void;
  foundCount: number;
  selectedCenter: [number, number] | null;
  topMatches: MatchedDriver[];
  onClear: () => void;
}

const MODES: { id: AnalysisMode; label: string }[] = [
  { id: "radius", label: "Radius Scan" },
  { id: "nearest", label: "Find Nearest" },
];

export const ControlPanelSpatial: React.FC<ControlPanelSpatialProps> = ({
  mode,
  setMode,
  radiusKm,
  setRadiusKm,
  nearestK,
  setNearestK,
  foundCount,
  selectedCenter,
  topMatches,
  onClear,
}) => {
  const isNearest = mode === "nearest";
  const resultLabel = isNearest ? "Nearest Found" : "Assets inside Buffer";
  const listHeading = isNearest ? `Top ${topMatches.length} Nearest` : `Top ${topMatches.length} Nearest`;

  return (
    <div
      style={{
        width: "320px",
        padding: "20px",
        backgroundColor: "#1e1b4b",
        color: "#f8fafc",
        boxShadow: "4px 0 15px rgba(0,0,0,0.5)",
        zIndex: 10,
        display: "flex",
        flexDirection: "column",
        gap: "16px",
        fontFamily: "sans-serif",
        overflowY: "auto",
      }}
    >
      <div>
        <h2 style={{ margin: "0 0 5px 0", fontSize: "1.25rem", color: "#a855f7" }}>
          Spatial Analytics
        </h2>
        <p style={{ margin: 0, fontSize: "0.85rem", color: "#94a3b8" }}>
          Real-time Geofencing & Buffer Zone
        </p>
      </div>

      {/* Mode toggle: segmented control, style giống menu mode-switching ở App.tsx */}
      <div
        style={{
          display: "flex",
          gap: 4,
          padding: 4,
          backgroundColor: "#0f172a",
          borderRadius: 8,
        }}
      >
        {MODES.map(({ id, label }) => {
          const active = mode === id;
          return (
            <button
              key={id}
              onClick={() => setMode(id)}
              style={{
                flex: 1,
                padding: "6px 8px",
                border: "none",
                borderRadius: 6,
                cursor: "pointer",
                fontWeight: 600,
                fontSize: "0.8rem",
                color: active ? "#0f172a" : "#94a3b8",
                backgroundColor: active ? "#a855f7" : "transparent",
                transition: "background-color 0.15s, color 0.15s",
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      <hr style={{ borderColor: "#312e81", margin: 0 }} />

      {/* Slider conditional theo mode */}
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {isNearest ? (
          <>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontSize: "0.95rem", fontWeight: "bold" }}>Nearest K:</span>
              <span style={{ color: "#a855f7", fontWeight: "bold" }}>{nearestK}</span>
            </div>
            <input
              type="range"
              min="1"
              max="20"
              step="1"
              value={nearestK}
              onChange={(e) => setNearestK(parseInt(e.target.value, 10))}
              style={{ width: "100%", cursor: "pointer" }}
            />
          </>
        ) : (
          <>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontSize: "0.95rem", fontWeight: "bold" }}>Scan Radius:</span>
              <span style={{ color: "#a855f7", fontWeight: "bold" }}>{radiusKm.toFixed(1)} km</span>
            </div>
            <input
              type="range"
              min="0.5"
              max="5"
              step="0.1"
              value={radiusKm}
              onChange={(e) => setRadiusKm(parseFloat(e.target.value))}
              style={{ width: "100%", cursor: "pointer" }}
            />
          </>
        )}
      </div>

      <hr style={{ borderColor: "#312e81", margin: 0 }} />

      {/* Kết quả */}
      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <h3 style={{ margin: 0, fontSize: "0.95rem", color: "#cbd5e1" }}>Analysis Result</h3>

        <div
          style={{
            padding: "12px",
            backgroundColor: "#0f172a",
            borderRadius: "6px",
            textAlign: "center",
          }}
        >
          <span
            style={{ display: "block", fontSize: "0.85rem", color: "#94a3b8", marginBottom: "4px" }}
          >
            {resultLabel}
          </span>
          <strong style={{ fontSize: "2rem", color: foundCount > 0 ? "#4ade80" : "#ef4444" }}>
            {foundCount}
          </strong>
        </div>

        <div style={{ fontSize: "0.85rem", color: "#94a3b8", lineHeight: 1.4 }}>
          <strong>Center Point:</strong>
          <br />
          {selectedCenter
            ? `Lng: ${selectedCenter[0].toFixed(4)}, Lat: ${selectedCenter[1].toFixed(4)}`
            : "Click on the map to place scan center"}
        </div>

        {selectedCenter && (
          <button
            onClick={onClear}
            style={{
              padding: "8px 12px",
              backgroundColor: "transparent",
              color: "#f8fafc",
              border: "1px solid #475569",
              borderRadius: "6px",
              cursor: "pointer",
              fontSize: "0.85rem",
              fontWeight: 600,
            }}
          >
            Clear Center
          </button>
        )}
      </div>

      {/* List kết quả (radius: top-5; nearest: full K) */}
      {topMatches.length > 0 && (
        <>
          <hr style={{ borderColor: "#312e81", margin: 0 }} />
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <h3 style={{ margin: 0, fontSize: "0.95rem", color: "#cbd5e1" }}>{listHeading}</h3>
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 4 }}>
              {topMatches.map((m, i) => (
                <li
                  key={m.idx}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    padding: "6px 10px",
                    backgroundColor: "#0f172a",
                    borderRadius: 4,
                    fontSize: "0.8rem",
                  }}
                >
                  <span style={{ color: "#cbd5e1" }}>
                    <span style={{ color: "#64748b", marginRight: 6 }}>#{i + 1}</span>
                    {driverName(m.idx)}
                  </span>
                  <span style={{ color: "#4ade80", fontWeight: 600 }}>
                    {m.distanceKm.toFixed(2)} km
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      <div
        style={{
          marginTop: "auto",
          fontSize: "0.75rem",
          color: "#64748b",
          textAlign: "center",
          lineHeight: 1.4,
        }}
      >
        {isNearest
          ? "Haversine across all assets, sorted ascending, top-K. No bbox prefilter."
          : "Bbox prefilter + haversine on client. Turf used only to draw the visual buffer polygon."}
      </div>
    </div>
  );
};
