import React from "react";

interface ControlPanelBigDataProps {
  totalPoints: number;
  viewportCount: number;
  isLoading: boolean;
  isStreaming: boolean;
  setIsStreaming: (active: boolean) => void;
  lastTickAt: number;
  onGenerateData: (count: number) => void;
}

const PRESETS: { label: string; count: number; color: string }[] = [
  { label: "50K", count: 50_000, color: "#334155" },
  { label: "200K", count: 200_000, color: "#475569" },
  { label: "500K", count: 500_000, color: "#7c3aed" },
  { label: "1M", count: 1_000_000, color: "#e11d48" },
];

export const ControlPanelBigData: React.FC<ControlPanelBigDataProps> = ({
  totalPoints,
  viewportCount,
  isLoading,
  isStreaming,
  setIsStreaming,
  lastTickAt,
  onGenerateData,
}) => {
  return (
    <div
      style={{
        width: "320px",
        padding: "20px",
        backgroundColor: "#0f172a",
        color: "#f8fafc",
        boxShadow: "4px 0 15px rgba(0,0,0,0.5)",
        zIndex: 10,
        display: "flex",
        flexDirection: "column",
        gap: "20px",
        fontFamily: "sans-serif",
      }}
    >
      <div>
        <h2 style={{ margin: "0 0 5px 0", fontSize: "1.25rem", color: "#f43f5e" }}>
          Big Data Geo-Engine
        </h2>
        <p style={{ margin: 0, fontSize: "0.85rem", color: "#94a3b8" }}>
          Live simulation · worker-side supercluster
        </p>
      </div>

      <hr style={{ borderColor: "#1e293b", margin: 0 }} />

      {/* Data scale */}
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        <h3 style={{ margin: 0, fontSize: "0.9rem", color: "#cbd5e1" }}>Data Scale Config</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
          {PRESETS.map((p) => (
            <button
              key={p.count}
              onClick={() => onGenerateData(p.count)}
              disabled={isLoading}
              style={{
                padding: "10px",
                backgroundColor: p.color,
                color: "#fff",
                border: "none",
                borderRadius: "4px",
                cursor: isLoading ? "not-allowed" : "pointer",
                fontSize: "0.85rem",
                fontWeight: "bold",
                opacity: isLoading ? 0.45 : 1,
                transition: "opacity 0.15s",
              }}
            >
              {p.label} Points
            </button>
          ))}
        </div>
        <div style={{ fontSize: "0.85rem", color: "#94a3b8", marginTop: "4px" }}>
          Total: <strong style={{ color: "#f43f5e" }}>{totalPoints.toLocaleString()}</strong>{" "}
          <span style={{ color: "#64748b" }}>· viewport: </span>
          <strong style={{ color: "#fcd34d" }}>{viewportCount.toLocaleString()}</strong>
        </div>
      </div>

      <hr style={{ borderColor: "#1e293b", margin: 0 }} />

      {/* Live streaming control */}
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        <h3 style={{ margin: 0, fontSize: "0.9rem", color: "#cbd5e1" }}>Live Stream (3s tick)</h3>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 12px",
            backgroundColor: "#1e293b",
            borderRadius: 4,
          }}
        >
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              backgroundColor: isStreaming ? "#4ade80" : "#64748b",
              animation: isStreaming ? "map-loading-spin 1.2s linear infinite" : "none",
              boxShadow: isStreaming ? "0 0 6px #4ade80" : "none",
            }}
          />
          <span style={{ flex: 1, fontSize: "0.85rem", color: "#cbd5e1" }}>
            {isStreaming ? `Simulating · tick #${lastTickAt}` : "Paused"}
          </span>
          <button
            onClick={() => setIsStreaming(!isStreaming)}
            disabled={isLoading}
            style={{
              padding: "5px 10px",
              backgroundColor: isStreaming ? "#475569" : "#4ade80",
              color: isStreaming ? "#f8fafc" : "#0f172a",
              border: "none",
              borderRadius: 4,
              cursor: isLoading ? "not-allowed" : "pointer",
              fontSize: "0.75rem",
              fontWeight: "bold",
              opacity: isLoading ? 0.45 : 1,
            }}
          >
            {isStreaming ? "Pause" : "Resume"}
          </button>
        </div>
      </div>

      <hr style={{ borderColor: "#1e293b", margin: 0 }} />

      {/* Auto-zoom strategy */}
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        <h3 style={{ margin: 0, fontSize: "0.9rem", color: "#cbd5e1" }}>Rendering Strategy (auto)</h3>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            padding: 10,
            backgroundColor: "#1e293b",
            borderRadius: 4,
            fontSize: "0.8rem",
            lineHeight: 1.4,
          }}
        >
          <div>
            <span style={{ color: "#f43f5e", fontWeight: "bold" }}>🔥 Zoom &lt; 10</span>
            <span style={{ color: "#94a3b8" }}> — GPU Heatmap</span>
          </div>
          <div>
            <span style={{ color: "#38bdf8", fontWeight: "bold" }}>🤖 Zoom 10–14</span>
            <span style={{ color: "#94a3b8" }}> — Supercluster</span>
          </div>
          <div>
            <span style={{ color: "#11b4da", fontWeight: "bold" }}>📍 Zoom 14+</span>
            <span style={{ color: "#94a3b8" }}> — Raw Points</span>
          </div>
        </div>
      </div>

      <div style={{ fontSize: "0.75rem", color: "#64748b", lineHeight: 1.5 }}>
        Worker giữ SoA Float32 + supercluster index. Mỗi 3s mutate positions toward destinations, rebuild index, send pre-clustered features cho viewport. Main không bao giờ giữ {totalPoints.toLocaleString()} FC.
      </div>
    </div>
  );
};
