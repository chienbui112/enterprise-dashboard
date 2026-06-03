// ControlPanelCesium.tsx
// React CHỈ quản lý UI: slider mức dâng, nút kích bão, chip trạng thái, thước đo, bảng log IoT.
// Dữ liệu nặng (Viewer, nước, cảm biến) nằm ngoài React. Slider ghi thẳng vào FloodController.

import { useEffect, useRef } from "react";
import { BASEMAP_OPTIONS, type BasemapId, type SensorStatus } from "../../utils/cesiumFloodHelpers";
import type { MeasureResult, TerrainStatus } from "./MapContainerCesium";

export interface SensorLog {
  seq: number;
  sensorId: string;
  level: number;
  status: SensorStatus;
}

interface Props {
  initialLevel: number;
  onManualLevel: (meters: number) => void;
  onToggleStorm: () => void;
  storming: boolean;
  isReady: boolean;
  logs: SensorLog[];
  riseLevel: number; // mức dâng hiện tại (m, so điểm thấp nhất)
  waterRange: number; // dải slider (m)
  dangerStations: number;
  warningStations: number;
  totalStations: number;
  terrainStatus: TerrainStatus;
  ionAvailable: boolean;
  buildingKept: number;
  buildingTotal: number;
  buildingInfo: Record<string, unknown> | null;
  onCloseBuildingInfo: () => void;
  waterEffect: boolean;
  onWaterEffect: (v: boolean) => void;
  basemap: BasemapId;
  onBasemap: (b: BasemapId) => void;
  measureMode: boolean;
  onMeasureMode: (v: boolean) => void;
  measureResult: MeasureResult | null;
}

const STATUS_META: Record<SensorStatus, { label: string; color: string }> = {
  normal: { label: "BÌNH THƯỜNG", color: "#22c55e" },
  warning: { label: "CẢNH BÁO", color: "#f59e0b" },
  danger: { label: "NGUY HIỂM", color: "#ef4444" },
};

export const ControlPanelCesium: React.FC<Props> = ({
  initialLevel,
  onManualLevel,
  onToggleStorm,
  storming,
  isReady,
  logs,
  riseLevel,
  waterRange,
  dangerStations,
  warningStations,
  totalStations,
  terrainStatus,
  ionAvailable,
  buildingKept,
  buildingTotal,
  buildingInfo,
  onCloseBuildingInfo,
  waterEffect,
  onWaterEffect,
  basemap,
  onBasemap,
  measureMode,
  onMeasureMode,
  measureResult,
}) => {
  // Ref tới DOM slider + nhãn: cập nhật trực tiếp, không setState -> bơm thẳng vào FloodController.
  const sliderRef = useRef<HTMLInputElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);

  const handleSlider = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (storming) return;
    const v = parseFloat(e.target.value);
    onManualLevel(v);
    if (labelRef.current) labelRef.current.textContent = v.toFixed(1);
  };

  // Khi BÃO: slider bị khoá nhưng vẫn phải PHẢN ÁNH mức nước dâng -> cập nhật thẳng DOM (thumb + nhãn)
  // theo riseLevel (không qua value controlled để khỏi đụng tới luồng kéo tay lúc thủ công).
  useEffect(() => {
    if (storming && sliderRef.current) {
      sliderRef.current.value = String(riseLevel);
      if (labelRef.current) labelRef.current.textContent = riseLevel.toFixed(1);
    }
  }, [storming, riseLevel]);

  const terrainMeta: Record<TerrainStatus, [string, string]> = {
    idle: ["#64748b", ionAvailable ? "● Sẵn sàng" : "● Không có ion token — nền phẳng (min=max=0)"],
    loading: ["#d97706", "● Đang tải Cesium World Terrain…"],
    ready: ["#16a34a", "● Địa hình thật đã tải — nhà bám terrain"],
    error: ["#ef4444", "● Lỗi tải địa hình — kiểm tra token"],
  };
  const [terrainColor, terrainLabel] = terrainMeta[terrainStatus];

  const metric = (label: string, value: string, color: string) => (
    <div style={{ display: "flex", justifyContent: "space-between", padding: 8, backgroundColor: "#1e293b", borderRadius: 4 }}>
      <span style={{ color: "#94a3b8", fontSize: "0.85rem" }}>{label}</span>
      <strong style={{ color }}>{value}</strong>
    </div>
  );

  return (
    <div
      style={{
        width: 360,
        minWidth: 360,
        padding: 20,
        backgroundColor: "#0f172a",
        color: "#f8fafc",
        boxShadow: "4px 0 15px rgba(0,0,0,0.5)",
        zIndex: 10,
        display: "flex",
        flexDirection: "column",
        gap: 16,
        fontFamily: "sans-serif",
        overflowY: "auto",
      }}
    >
      <div>
        <h2 style={{ margin: "0 0 5px 0", fontSize: "1.2rem", color: "#38bdf8" }}>🌊 Digital Twin Ngập lụt — CesiumJS</h2>
        <p style={{ margin: 0, fontSize: "0.82rem", color: "#94a3b8" }}>Địa hình thật · mặt nước ở cao độ tuyệt đối · vùng trũng ngập trước</p>
      </div>

      <hr style={{ borderColor: "#1e293b", margin: 0 }} />

      {/* ĐỊA HÌNH + MÔ HÌNH 3D */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <h3 style={{ margin: 0, fontSize: "0.95rem", color: "#e2e8f0" }}>Địa hình &amp; mô hình 3D</h3>
        <div style={{ padding: 8, backgroundColor: "#1e293b", borderRadius: 4, fontSize: "0.78rem", lineHeight: 1.4 }}>
          <span style={{ color: terrainColor, fontWeight: 600 }}>{terrainLabel}</span>
          <div style={{ color: "#64748b", marginTop: 4 }}>
            Cesium World Terrain (địa hình thật) + nhà THẬT từ <code>hn_buildings.geojson</code> (extrude theo{" "}
            <code>building_l</code>×3.4m, mặc định 4.5m), đặt đúng cao độ địa hình. Nước là mặt phẳng ở cao độ W; chỗ
            trũng ngập trước.
          </div>
          <div style={{ color: "#cbd5e1", marginTop: 4 }}>
            Nhà đã dựng: <strong style={{ color: "#4ade80" }}>{buildingKept.toLocaleString()}</strong>
            {buildingTotal > buildingKept ? ` / ${buildingTotal.toLocaleString()} (lọc theo vùng + giới hạn)` : ""}
          </div>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "0.82rem", color: "#cbd5e1" }}>
          <input type="checkbox" checked={waterEffect} onChange={(e) => onWaterEffect(e.target.checked)} />
          Hiệu ứng sóng nước (<code>Cesium.Material.WaterType</code>)
        </label>

        <span style={{ fontSize: "0.82rem", color: "#cbd5e1", marginTop: 2 }}>Bản đồ nền</span>
        <div style={{ display: "flex", gap: 6 }}>
          {BASEMAP_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              onClick={() => onBasemap(opt.id)}
              style={{
                flex: 1,
                padding: "7px 4px",
                fontSize: "0.76rem",
                fontWeight: 600,
                backgroundColor: basemap === opt.id ? "#0ea5e9" : "#1e293b",
                color: basemap === opt.id ? "#fff" : "#94a3b8",
                border: `1px solid ${basemap === opt.id ? "#0ea5e9" : "#334155"}`,
                borderRadius: 4,
                cursor: "pointer",
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* THÔNG TIN TOÀ NHÀ (hiện khi click nhà lúc thước đo TẮT) */}
      {buildingInfo && (
        <>
          <hr style={{ borderColor: "#1e293b", margin: 0 }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ margin: 0, fontSize: "0.95rem", color: "#e2e8f0" }}>🏢 Thông tin toà nhà</h3>
              <button
                onClick={onCloseBuildingInfo}
                style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", fontSize: "1rem" }}
              >
                ✕
              </button>
            </div>
            <div style={{ backgroundColor: "#0b1322", borderRadius: 6, border: "1px solid #1e293b", maxHeight: 220, overflowY: "auto" }}>
              {Object.entries(buildingInfo)
                .filter(([, v]) => v !== null && v !== undefined && v !== "")
                .map(([k, v]) => (
                  <div
                    key={k}
                    style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "4px 10px", borderBottom: "1px solid #131c2e", fontSize: "0.74rem", fontFamily: "monospace" }}
                  >
                    <span style={{ color: "#64748b" }}>{k}</span>
                    <span style={{ color: "#cbd5e1", textAlign: "right", wordBreak: "break-word" }}>{String(v)}</span>
                  </div>
                ))}
            </div>
            <p style={{ margin: 0, fontSize: "0.72rem", color: "#64748b" }}>
              Bấm vào toà nhà khác để xem, hoặc bật 📏 để đo cao độ/ngập.
            </p>
          </div>
        </>
      )}

      <hr style={{ borderColor: "#1e293b", margin: 0 }} />

      {/* SLIDER MỨC NƯỚC DÂNG */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h3 style={{ margin: 0, fontSize: "0.95rem", color: "#e2e8f0" }}>
          Mực nước dâng (so điểm thấp nhất):{" "}
          <span ref={labelRef} style={{ color: "#38bdf8" }}>
            {initialLevel.toFixed(1)}
          </span>{" "}
          m
        </h3>
        <input
          ref={sliderRef}
          type="range"
          min={0}
          max={waterRange}
          step={0.1}
          defaultValue={initialLevel}
          onChange={handleSlider}
          disabled={!isReady || storming}
          style={{ width: "100%", accentColor: "#0ea5e9", opacity: storming ? 0.5 : 1 }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.72rem", color: "#64748b" }}>
          <span>0 m</span>
          <span>{(waterRange / 2).toFixed(1)} m</span>
          <span>{waterRange.toFixed(1)} m</span>
        </div>
        <p style={{ margin: 0, fontSize: "0.74rem", color: "#64748b", lineHeight: 1.4 }}>
          Mức dâng đặt cao độ mặt nước W = (điểm thấp nhất) + giá trị này. Nước tràn vào vùng trũng trước, lên dần vùng cao. Giá trị đọc bởi{" "}
          <code>CallbackProperty</code> (60 FPS, không re-render).
        </p>
      </div>

      {/* KỊCH BẢN BÃO */}
      <button
        onClick={onToggleStorm}
        disabled={!isReady}
        style={{
          padding: "12px",
          backgroundColor: storming ? "#ef4444" : "#0ea5e9",
          color: "#fff",
          border: "none",
          borderRadius: 6,
          cursor: !isReady ? "not-allowed" : "pointer",
          fontWeight: "bold",
          fontSize: "0.92rem",
          opacity: !isReady ? 0.5 : 1,
        }}
      >
        {storming ? "■ Dừng kịch bản bão" : "⛈️ Kích hoạt kịch bản: Bão đổ bộ"}
      </button>
      {storming && (
        <p style={{ margin: 0, fontSize: "0.74rem", color: "#fca5a5", lineHeight: 1.4 }}>
          Luồng cảm biến IoT (giả lập WebSocket) đang bắn mỗi giây. Mực nước dâng dần — hố ga vùng trũng ngập sâu/sớm hơn. Slider bị khoá trong lúc
          bão.
        </p>
      )}

      <hr style={{ borderColor: "#1e293b", margin: 0 }} />

      {/* CHỈ SỐ THỜI GIAN THỰC (hố ga) */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: "0.95rem", color: "#e2e8f0" }}>Giám sát thời gian thực</h3>
        {metric("Mực nước dâng:", `${riseLevel.toFixed(2)} m`, "#38bdf8")}
        {metric("Hố ga NGUY HIỂM:", `${dangerStations} / ${totalStations}`, dangerStations > 0 ? "#ef4444" : "#f8fafc")}
        {metric("Hố ga cảnh báo:", `${warningStations} / ${totalStations}`, warningStations > 0 ? "#f59e0b" : "#f8fafc")}
      </div>

      <hr style={{ borderColor: "#1e293b", margin: 0 }} />

      {/* THƯỚC ĐO CAO ĐỘ */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: "0.95rem", color: "#e2e8f0" }}>📏 Thước đo cao độ</h3>
        <button
          onClick={() => onMeasureMode(!measureMode)}
          disabled={!isReady}
          style={{
            padding: "10px",
            backgroundColor: measureMode ? "#eab308" : "#1e293b",
            color: measureMode ? "#0f172a" : "#cbd5e1",
            border: `1px solid ${measureMode ? "#eab308" : "#334155"}`,
            borderRadius: 6,
            cursor: !isReady ? "not-allowed" : "pointer",
            fontWeight: "bold",
            fontSize: "0.85rem",
            opacity: !isReady ? 0.5 : 1,
          }}
        >
          {measureMode ? "■ Tắt thước đo" : "📏 Bật thước đo (bấm lên cảnh)"}
        </button>
        {measureResult ? (
          <div
            style={{
              padding: 10,
              backgroundColor: "#0b1322",
              borderRadius: 6,
              border: "1px solid #1e293b",
              fontSize: "0.78rem",
              fontFamily: "monospace",
              lineHeight: 1.6,
            }}
          >
            <div style={{ color: "#94a3b8" }}>
              📍 {measureResult.lat.toFixed(5)}, {measureResult.lon.toFixed(5)}
            </div>
            <div style={{ color: "#64748b" }}>Cao độ tuyệt đối (ellipsoid, m):</div>
            <div style={{ color: "#cbd5e1" }}>
              • Mặt đất: <strong style={{ color: "#a3a3a3" }}>{measureResult.terrainElevation.toFixed(1)}</strong>
              {"  · Mặt nước W: "}
              <strong style={{ color: "#38bdf8" }}>{measureResult.waterElevation.toFixed(1)}</strong>
            </div>
            <div style={{ color: "#cbd5e1" }}>
              • Ngập tại điểm (W − đất):{" "}
              <strong style={{ color: measureResult.waterDepth > 0.05 ? "#0ea5e9" : "#64748b" }}>{measureResult.waterDepth.toFixed(2)} m</strong>
            </div>
            {measureResult.buildingHeight != null && measureResult.buildingSubmersion != null && (
              <>
                <div style={{ color: "#cbd5e1" }}>
                  • Nhà cao: <strong style={{ color: "#4ade80" }}>{measureResult.buildingHeight.toFixed(1)} m</strong>
                  {" · ngập thân: "}
                  <strong style={{ color: "#0ea5e9" }}>{measureResult.buildingSubmersion.toFixed(1)} m</strong>
                </div>
                <div
                  style={{
                    marginTop: 4,
                    padding: "4px 6px",
                    borderRadius: 4,
                    backgroundColor: measureResult.buildingSubmersion >= measureResult.buildingHeight ? "#7f1d1d" : "#16233a",
                    color: measureResult.buildingSubmersion >= measureResult.buildingHeight ? "#fecaca" : "#94a3b8",
                    fontWeight: 700,
                  }}
                >
                  {measureResult.buildingSubmersion >= measureResult.buildingHeight
                    ? "🔴 NGẬP QUÁ NÓC"
                    : measureResult.buildingSubmersion > 0.05
                      ? `🟠 Ngập ${measureResult.buildingSubmersion.toFixed(1)} m thân nhà`
                      : "🟢 Chưa ngập"}
                </div>
              </>
            )}
          </div>
        ) : (
          measureMode && (
            <div style={{ padding: 8, fontSize: "0.74rem", color: "#64748b" }}>
              Bấm chuột trái lên mặt đất hoặc toà nhà. Mọi cao độ cùng hệ ellipsoid: độ sâu = mặt nước − mặt đất; ngập thân nhà = mặt nước − chân nhà.
            </div>
          )
        )}
      </div>

      <hr style={{ borderColor: "#1e293b", margin: 0 }} />

      {/* BẢNG LOG IoT */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: "0.95rem", color: "#e2e8f0" }}>Log cảm biến IoT</h3>
        <div
          style={{
            backgroundColor: "#0b1322",
            borderRadius: 6,
            border: "1px solid #1e293b",
            maxHeight: 240,
            overflowY: "auto",
            fontSize: "0.74rem",
            fontFamily: "monospace",
          }}
        >
          {logs.length === 0 ? (
            <div style={{ padding: 12, color: "#64748b" }}>Chưa có dữ liệu. Bấm “Bão đổ bộ” để bắt đầu.</div>
          ) : (
            logs.map((log) => {
              const meta = STATUS_META[log.status];
              return (
                <div
                  key={log.seq}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "5px 10px",
                    borderBottom: "1px solid #131c2e",
                  }}
                >
                  <span style={{ color: "#94a3b8" }}>{log.sensorId}</span>
                  <span style={{ color: "#cbd5e1" }}>{log.level.toFixed(2)} m</span>
                  <span style={{ color: meta.color, fontWeight: 700, fontSize: "0.66rem" }}>{meta.label}</span>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div style={{ marginTop: "auto", fontSize: "0.74rem", color: "#64748b", lineHeight: 1.5 }}>
        <strong>Kiến trúc:</strong> Mặt nước là khối <code>PolygonGeometry</code> ở cao độ tuyệt đối W, gắn <code>CallbackProperty</code> +{" "}
        <code>depthTestAgainstTerrain</code> nên địa hình cao hơn tự che nước. Nhà ngập một phần →{" "}
        <span style={{ color: "#f59e0b" }}>cam</span>, ngập quá nóc → <span style={{ color: "#ef4444" }}>đỏ</span>. Nghiêng/xoay:{" "}
        <strong>chuột phải + kéo</strong>.
      </div>
    </div>
  );
};
