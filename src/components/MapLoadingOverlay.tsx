import React from "react";

interface MapLoadingOverlayProps {
  visible: boolean;
  label?: string;
}

// Overlay che vùng bản đồ khi đang xử lý mà chưa có dữ liệu hiển thị.
// Đặt position:absolute -> phủ lên map container (cha cần position:relative).
export const MapLoadingOverlay: React.FC<MapLoadingOverlayProps> = ({ visible, label = "Đang xử lý dữ liệu..." }) => {
  if (!visible) return null;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        backgroundColor: "rgba(15, 23, 42, 0.55)",
        backdropFilter: "blur(2px)",
        color: "#f8fafc",
        fontFamily: "sans-serif",
        zIndex: 5,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          width: 48,
          height: 48,
          border: "4px solid rgba(248, 250, 252, 0.2)",
          borderTopColor: "#38bdf8",
          borderRadius: "50%",
          animation: "map-loading-spin 0.9s linear infinite",
        }}
      />
      <div style={{ fontSize: "0.95rem", fontWeight: 600, letterSpacing: 0.2 }}>{label}</div>
    </div>
  );
};
