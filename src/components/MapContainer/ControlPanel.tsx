import React from "react";

interface ControlPanelProps {
  isBboxFilterActive: boolean;
  setIsBboxFilterActive: (val: boolean) => void;
  isStreamingActive: boolean;
  setIsStreamingActive: (val: boolean) => void;
  totalDriversCount: number;
  visibleDriversCount: number;
  apiCallsCount: number;
}

export const ControlPanel: React.FC<ControlPanelProps> = ({
  isBboxFilterActive,
  setIsBboxFilterActive,
  isStreamingActive,
  setIsStreamingActive,
  totalDriversCount,
  visibleDriversCount,
  apiCallsCount,
}) => {
  return (
    <div
      style={{
        width: "320px",
        padding: "20px",
        backgroundColor: "#1e293b",
        color: "#f8fafc",
        boxShadow: "4px 0 15px rgba(0,0,0,0.3)",
        zIndex: 10,
        display: "flex",
        flexDirection: "column",
        gap: "20px",
        fontFamily: "sans-serif",
      }}
    >
      <div>
        <h2 style={{ margin: "0 0 5px 0", fontSize: "1.25rem", color: "#38bdf8" }}>WebGIS Enterprise</h2>
        <p style={{ margin: 0, fontSize: "0.85rem", color: "#94a3b8" }}>Performance Optimization Demo</p>
      </div>

      <hr style={{ borderColor: "#334155", margin: 0 }} />

      {/* Toggles */}
      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <label style={{ display: "flex", alignItems: "center", gap: "10px", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={isBboxFilterActive}
            onChange={(e) => setIsBboxFilterActive(e.target.checked)}
            style={{ width: "18px", height: "18px" }}
          />
          <div>
            <strong style={{ display: "block", fontSize: "0.95rem" }}>Bbox Server Filter</strong>
            <small style={{ color: "#94a3b8" }}>Only fetch visible assets</small>
          </div>
        </label>

        <label style={{ display: "flex", alignItems: "center", gap: "10px", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={isStreamingActive}
            onChange={(e) => setIsStreamingActive(e.target.checked)}
            style={{ width: "18px", height: "18px" }}
          />
          <div>
            <strong style={{ display: "block", fontSize: "0.95rem" }}>Real-time SSE Stream</strong>
            <small style={{ color: "#94a3b8" }}>Simulate live updates</small>
          </div>
        </label>
      </div>

      <hr style={{ borderColor: "#334155", margin: 0 }} />

      {/* Real-time Metrics Dashboard */}
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        <h3 style={{ margin: "0 0 5px 0", fontSize: "1rem", color: "#e2e8f0" }}>Live System Metrics</h3>

        <div style={{ display: "flex", justifyContent: "space-between", padding: "8px", backgroundColor: "#0f172a", borderRadius: "4px" }}>
          <span style={{ color: "#94a3b8", fontSize: "0.9rem" }}>Total System Fleet:</span>
          <strong style={{ color: "#f8fafc" }}>{totalDriversCount}</strong>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", padding: "8px", backgroundColor: "#0f172a", borderRadius: "4px" }}>
          <span style={{ color: "#94a3b8", fontSize: "0.9rem" }}>Rendered on Screen:</span>
          <strong style={{ color: isBboxFilterActive ? "#4ade80" : "#f8fafc" }}>{visibleDriversCount}</strong>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", padding: "8px", backgroundColor: "#0f172a", borderRadius: "4px" }}>
          <span style={{ color: "#94a3b8", fontSize: "0.9rem" }}>Network API Hits:</span>
          <strong style={{ color: "#f59e0b" }}>{apiCallsCount}</strong>
        </div>
      </div>

      <div style={{ marginTop: "auto", fontSize: "0.75rem", color: "#64748b", textAlign: "center", lineHeight: "1.4" }}>
        Pro Tip: Zoom in/out and pan the map to see the "Rendered" count and "API Hits" update instantly.
      </div>
    </div>
  );
};
