import React from "react";

interface ControlPanel3dProps {
  onLoadData: (count: number) => void;
  isProcessing: boolean;
  parseTime: number;
  renderedBuildings: number;
  totalBuildings: number;
}

export const ControlPanel3d: React.FC<ControlPanel3dProps> = ({ onLoadData, isProcessing, parseTime, renderedBuildings, totalBuildings }) => {
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
        <h2 style={{ margin: "0 0 5px 0", fontSize: "1.25rem", color: "#10b981" }}>3D Spatial Optimizer</h2>
        <p style={{ margin: 0, fontSize: "0.85rem", color: "#94a3b8" }}>Web Worker & 3D Extrusion</p>
      </div>

      <hr style={{ borderColor: "#1e293b", margin: 0 }} />

      {/* Hành động */}
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        <h3 style={{ margin: 0, fontSize: "0.95rem", color: "#e2e8f0" }}>Generate Mock Datasets</h3>
        <button
          onClick={() => onLoadData(25000)} // Sinh 25,000 Polygons
          disabled={isProcessing}
          style={{
            padding: "10px",
            backgroundColor: "#3b82f6",
            color: "#fff",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
            fontWeight: "bold",
            opacity: isProcessing ? 0.5 : 1,
          }}
        >
          Load 25,000 Buildings (Light)
        </button>
        <button
          onClick={() => onLoadData(100000)} // Sinh 100,000 Polygons (~50MB String)
          disabled={isProcessing}
          style={{
            padding: "10px",
            backgroundColor: "#ef4444",
            color: "#fff",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
            fontWeight: "bold",
            opacity: isProcessing ? 0.5 : 1,
          }}
        >
          Load 100,000 Buildings (Heavy)
        </button>
      </div>

      <hr style={{ borderColor: "#1e293b", margin: 0 }} />

      {/* Bảng chỉ số */}
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        <h3 style={{ margin: 0, fontSize: "1rem", color: "#e2e8f0" }}>Performance Diagnostics</h3>

        <div style={{ display: "flex", justifyContent: "space-between", padding: "8px", backgroundColor: "#1e293b", borderRadius: "4px" }}>
          <span style={{ color: "#94a3b8", fontSize: "0.9rem" }}>Worker Parse Time:</span>
          <strong style={{ color: "#4ade80" }}>{parseTime > 0 ? `${parseTime.toFixed(1)} ms` : "N/A"}</strong>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", padding: "8px", backgroundColor: "#1e293b", borderRadius: "4px" }}>
          <span style={{ color: "#94a3b8", fontSize: "0.9rem" }}>Total in Memory:</span>
          <strong style={{ color: "#f8fafc" }}>{totalBuildings.toLocaleString()}</strong>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", padding: "8px", backgroundColor: "#1e293b", borderRadius: "4px" }}>
          <span style={{ color: "#94a3b8", fontSize: "0.9rem" }}>Rendered in Viewport:</span>
          <strong style={{ color: "#38bdf8" }}>{renderedBuildings.toLocaleString()}</strong>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", padding: "8px", backgroundColor: "#1e293b", borderRadius: "4px" }}>
          <span style={{ color: "#94a3b8", fontSize: "0.9rem" }}>Main UI Thread Status:</span>
          <strong style={{ color: isProcessing ? "#f59e0b" : "#4ade80" }}>{isProcessing ? "Parsing Ngầm..." : "Mượt Mà (60 FPS)"}</strong>
        </div>
      </div>

      <div style={{ marginTop: "auto", fontSize: "0.8rem", color: "#64748b", lineHeight: "1.4" }}>
        <strong>Mẹo tương tác:</strong> Nhấn giữ nút <strong>Right-click chuột + kéo</strong> hoặc giữ phím <strong>Shift</strong> để nghiêng bản đồ
        (Pitch) xem các tòa nhà dựng khối 3D đổ bóng cực đẹp!
      </div>
    </div>
  );
};
