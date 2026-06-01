import React from "react";
import type { InterpolationMode } from "./index";

interface ControlPanelStreamProps {
  networkTickCount: number;
  fps: number;
  visibleCount: number;
  interpolationMode: InterpolationMode;
  isInterpolating: boolean;
  setIsInterpolating: (val: boolean) => void;
}

const CAP_ENTER = 8000; // khớp với MapContainerStream

export const ControlPanelStream: React.FC<ControlPanelStreamProps> = ({
  networkTickCount,
  fps,
  visibleCount,
  interpolationMode,
  isInterpolating,
  setIsInterpolating,
}) => {
  // Trạng thái mượt thật sự = bật nội suy VÀ chưa vượt cap.
  const isSmooth = isInterpolating && interpolationMode === "smooth";
  const overCap = interpolationMode === "snap" && isInterpolating;

  return (
    <div
      style={{
        width: "320px",
        padding: "20px",
        backgroundColor: "#022c22",
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
        <h2 style={{ margin: "0 0 5px 0", fontSize: "1.25rem", color: "#34d399" }}>Driver Telemetry</h2>
        <p style={{ margin: 0, fontSize: "0.85rem", color: "#a7f3d0" }}>Motion Interpolation & Animation</p>
      </div>

      <hr style={{ borderColor: "#064e3b", margin: 0 }} />

      {/* Cơ chế bật tắt Nội suy */}
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        <span style={{ fontSize: "0.9rem", color: "#a7f3d0", fontWeight: "bold" }}>Optimization Technology:</span>
        <label style={{ display: "flex", alignItems: "center", gap: "10px", cursor: "pointer", fontSize: "0.95rem" }}>
          <input
            type="checkbox"
            checked={isInterpolating}
            onChange={(e) => setIsInterpolating(e.target.checked)}
            style={{ width: "18px", height: "18px", cursor: "pointer" }}
          />
          Enable 60fps Motion Interpolation
        </label>
      </div>

      <hr style={{ borderColor: "#064e3b", margin: 0 }} />

      {/* Monitor Chỉ số */}
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        <h3 style={{ margin: 0, fontSize: "0.95rem", color: "#cbd5e1" }}>Telemetry Diagnostics</h3>

        <div style={{ display: "flex", justifyContent: "space-between", padding: "8px", backgroundColor: "#064e3b", borderRadius: "4px" }}>
          <span style={{ color: "#a7f3d0", fontSize: "0.9rem" }}>Network API Updates:</span>
          <strong style={{ color: "#fff" }}>Every 3.0 seconds</strong>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", padding: "8px", backgroundColor: "#064e3b", borderRadius: "4px" }}>
          <span style={{ color: "#a7f3d0", fontSize: "0.9rem" }}>Network Packets Received:</span>
          <strong style={{ color: "#34d399" }}>{networkTickCount} packets</strong>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", padding: "8px", backgroundColor: "#064e3b", borderRadius: "4px" }}>
          <span style={{ color: "#a7f3d0", fontSize: "0.9rem" }}>Vehicles in Viewport:</span>
          <strong style={{ color: "#fff" }}>{visibleCount.toLocaleString()}</strong>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", padding: "8px", backgroundColor: "#064e3b", borderRadius: "4px" }}>
          <span style={{ color: "#a7f3d0", fontSize: "0.9rem" }}>Screen Refresh Rate:</span>
          <strong style={{ color: isSmooth ? "#34d399" : "#f59e0b" }}>
            {isInterpolating ? `~${fps} FPS ${isSmooth ? "(Smooth)" : "(Capped)"}` : "0.33 FPS (Laggy)"}
          </strong>
        </div>
      </div>

      {/* Cảnh báo khi vượt cap nội suy */}
      {overCap && (
        <div style={{ padding: "10px", backgroundColor: "#7c2d12", borderRadius: "6px", fontSize: "0.8rem", lineHeight: "1.4", color: "#fed7aa" }}>
          ⚠️ Hiển thị <strong>{visibleCount.toLocaleString()}</strong> xe — vượt cap{" "}
          <strong>{CAP_ENTER.toLocaleString()}</strong>. Tạm "snap" mỗi 3s để giữ FPS. <strong>Zoom gần</strong> để bật lại nội suy 60fps mượt.
        </div>
      )}

      <div style={{ marginTop: "auto", fontSize: "0.8rem", color: "#65a30d", lineHeight: "1.4" }}>
        {isSmooth ? (
          <p style={{ margin: 0 }}>
            🟢 <strong>Bản chất:</strong> Worker chỉ đẩy 1 gói tọa độ mỗi 3s (tiết kiệm tài nguyên như Grab/Uber), nhưng main thread tự "vẽ bù" ~180
            khung hình trung gian bằng nội suy tuyến tính để cả đội xe di chuyển mịn màng 60fps.
          </p>
        ) : isInterpolating ? (
          <p style={{ margin: 0 }}>
            🟠 <strong>Chế độ cap:</strong> Quá nhiều xe trong khung nhìn để nội suy mỗi frame — tạm snap theo gói mạng 3s.
          </p>
        ) : (
          <p style={{ margin: 0 }}>
            🟠 <strong>Bản chất:</strong> Tắt nội suy. Xe đứng yên 3 giây rồi nhảy vọt sang vị trí mới giống như bị gián đoạn mạng.
          </p>
        )}
      </div>
    </div>
  );
};
