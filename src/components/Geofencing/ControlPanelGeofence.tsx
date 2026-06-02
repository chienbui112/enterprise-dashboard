import React from "react";
import { driverName } from "../../utils/geoHelpers";
import type { AlertEntry } from "./index";

interface ControlPanelGeofenceProps {
  vehicleTotal: number;
  geofenceTotal: number;
  visibleCount: number;
  totalViolating: number;
  tickCount: number;
  pipCount: number;
  enterTotal: number;
  exitTotal: number;
  alerts: AlertEntry[];
  isMonitoring: boolean;
  setIsMonitoring: (val: boolean) => void;
  speedFactor: number;
  setSpeedFactor: (val: number) => void;
}

const statBox = (label: string, value: React.ReactNode, color = "#fff") => (
  <div style={{ display: "flex", justifyContent: "space-between", padding: "8px", backgroundColor: "#3f1d1d", borderRadius: "4px" }}>
    <span style={{ color: "#fca5a5", fontSize: "0.75rem" }}>{label}</span>
    <strong style={{ color }}>{value}</strong>
  </div>
);

export const ControlPanelGeofence: React.FC<ControlPanelGeofenceProps> = ({
  vehicleTotal,
  geofenceTotal,
  visibleCount,
  totalViolating,
  tickCount,
  pipCount,
  enterTotal,
  exitTotal,
  alerts,
  isMonitoring,
  setIsMonitoring,
  speedFactor,
  setSpeedFactor,
}) => {
  // Số phép so sánh nếu Tầng 1 quét brute-force (xe × vùng) — để đối chiếu với số PiP thực tế.
  const bruteForce = vehicleTotal * geofenceTotal;
  const speedLabel = speedFactor === 0 ? "Đứng yên" : speedFactor < 1 ? "Chậm" : speedFactor <= 1.5 ? "Vừa" : "Nhanh";
  return (
    <div
      style={{
        width: "340px",
        padding: "10px",
        backgroundColor: "#1a0a0a",
        color: "#f8fafc",
        boxShadow: "4px 0 15px rgba(0,0,0,0.5)",
        zIndex: 10,
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        fontFamily: "sans-serif",
        overflow: "hidden",
      }}
    >
      <div>
        <h2 style={{ margin: "0 0 5px 0", fontSize: "1.25rem", color: "#f87171" }}>Geofence Monitor</h2>
        <p style={{ margin: 0, fontSize: "0.85rem", color: "#fca5a5" }}>
          {vehicleTotal.toLocaleString()} xe · {geofenceTotal.toLocaleString()} vùng cấm · Grid + 2-tầng lọc · toàn VN
        </p>
      </div>

      <hr style={{ borderColor: "#7f1d1d", margin: 0 }} />

      {/* Bật/tắt giám sát (stream simulation trong worker) */}
      <label style={{ display: "flex", alignItems: "center", gap: "10px", cursor: "pointer", fontSize: "0.75rem" }}>
        <input
          type="checkbox"
          checked={isMonitoring}
          onChange={(e) => setIsMonitoring(e.target.checked)}
          style={{ width: "18px", height: "18px", cursor: "pointer" }}
        />
        Real-time Monitoring {isMonitoring ? "(ON)" : "(PAUSED)"}
      </label>

      {/* Thanh trượt tốc độ di chuyển của xe */}
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: "0.75rem" }}>
          <span style={{ color: "#fca5a5", fontWeight: "bold" }}>Tốc độ di chuyển</span>
          <strong style={{ color: speedFactor === 0 ? "#9ca3af" : "#f87171" }}>
            {speedFactor.toFixed(1)}× · {speedLabel}
          </strong>
        </div>
        <input
          type="range"
          min={0}
          max={3}
          step={0.1}
          value={speedFactor}
          onChange={(e) => setSpeedFactor(parseFloat(e.target.value))}
          style={{ width: "100%", cursor: "pointer", accentColor: "#f87171" }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.7rem", color: "#9ca3af" }}>
          <span>Đứng yên</span>
          <span>Nhanh (3×)</span>
        </div>
        <p style={{ margin: 0, fontSize: "0.72rem", color: "#9ca3af", lineHeight: 1.4 }}>
          Giảm tốc độ → xe qua vùng cấm chậm hơn → ít sự kiện Enter/Exit hơn. Kéo về 0 để xe đứng yên.
        </p>
      </div>

      <hr style={{ borderColor: "#7f1d1d", margin: 0 }} />

      {/* Chỉ số */}
      <div style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "0.75rem" }}>
        {statBox("Xe đang vi phạm:", totalViolating.toLocaleString(), totalViolating > 0 ? "#ef4444" : "#4ade80")}
        {statBox("Xe trong viewport:", visibleCount.toLocaleString())}
        {statBox("Tổng lượt VÀO (Enter):", enterTotal.toLocaleString(), "#fbbf24")}
        {statBox("Tổng lượt RA (Exit):", exitTotal.toLocaleString(), "#60a5fa")}
        {statBox("Turf PiP checks/tick:", pipCount.toLocaleString(), "#34d399")}
        {statBox("Simulation ticks:", tickCount.toLocaleString())}
      </div>

      {/* Hiệu quả của spatial grid: PiP thực tế so với brute-force xe×vùng */}
      <div style={{ padding: "10px", backgroundColor: "#052e1b", borderRadius: "6px", fontSize: "0.75rem", lineHeight: 1.5, color: "#a7f3d0" }}>
        ⚡ <strong>Grid index:</strong> chỉ <strong style={{ color: "#34d399" }}>{pipCount.toLocaleString()}</strong> phép Point-in-Polygon mỗi tick,
        thay vì <strong>{bruteForce.toLocaleString()}</strong> cặp nếu quét toàn bộ ({vehicleTotal.toLocaleString()} xe ×{" "}
        {geofenceTotal.toLocaleString()} vùng).
      </div>

      <hr style={{ borderColor: "#7f1d1d", margin: 0 }} />

      {/* Log cảnh báo real-time */}
      <div style={{ display: "flex", flexDirection: "column", gap: "8px", flex: 1, minHeight: 0 }}>
        <h3 style={{ margin: 0, fontSize: "0.75rem", color: "#fecaca" }}>
          🚨 Cảnh báo trực tiếp{" "}
          {enterTotal + exitTotal > 0 && (
            <span style={{ color: "#fca5a5", fontWeight: 400 }}>
              ({(enterTotal + exitTotal).toLocaleString()} sự kiện · xem {Math.min(alerts.length, 80)} gần nhất)
            </span>
          )}
        </h3>
        <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: "4px", paddingRight: "4px" }}>
          {alerts.length === 0 ? (
            <p style={{ margin: 0, fontSize: "0.8rem", color: "#9ca3af" }}>Chưa có sự kiện ra/vào nào...</p>
          ) : (
            alerts.map((a) => (
              <div
                key={a.seq}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "6px 8px",
                  borderRadius: "4px",
                  fontSize: "0.75rem",
                  backgroundColor: a.type === "enter" ? "#450a0a" : "#0c2a4a",
                  borderLeft: `3px solid ${a.type === "enter" ? "#ef4444" : "#3b82f6"}`,
                }}
              >
                <span style={{ fontWeight: 700, color: a.type === "enter" ? "#f87171" : "#60a5fa" }}>{a.type === "enter" ? "⮕ VÀO" : "⬅ RA"}</span>
                <span style={{ color: "#e5e7eb", flex: 1 }}>
                  {driverName(a.idx)} · Vùng #{a.zone}
                </span>
                <span style={{ color: "#9ca3af", fontVariantNumeric: "tabular-nums" }}>{a.time}</span>
              </div>
            ))
          )}
        </div>
      </div>

      <div style={{ fontSize: "0.75rem", color: "#9ca3af", lineHeight: 1.4 }}>
        <p style={{ margin: 0 }}>
          🔴 <strong>3 lớp lọc:</strong> Grid index băm vùng cấm vào ô lưới (xe chỉ xét vùng cùng ô) → Tầng 1 bounding-box (đại số) → Tầng 2 Turf{" "}
          <code>booleanPointInPolygon</code>. Tất cả trong Worker. Cache trạng thái (typed array) chỉ phát alert khi xe đổi OUTSIDE↔INSIDE — tránh bão
          log.
        </p>
      </div>
    </div>
  );
};
