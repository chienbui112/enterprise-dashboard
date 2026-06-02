import React from "react";
import { driverName } from "../../utils/geoHelpers";
import { PROXIMITY_M } from "../../utils/playbackHelpers";
import type { CollisionAlert, MeasureInfo } from "./index";

interface ControlPanelPlaybackProps {
  vehicleTotal: number;
  durationSec: number;
  genMs: number;
  isReady: boolean;
  isPlaying: boolean;
  togglePlay: () => void;
  currentTime: number;
  onScrub: (t: number) => void;
  speed: number;
  setSpeed: (v: number) => void;
  collisionCount: number;
  checkCount: number;
  fps: number;
  totalEvents: number;
  alerts: CollisionAlert[];
  measureMode: boolean;
  toggleMeasure: () => void;
  measureInfo: MeasureInfo | null;
}

// `hint` -> tooltip (title) giải thích ý nghĩa chỉ số ngay trên panel khi rê chuột.
const statBox = (label: string, value: React.ReactNode, color = "#fff", hint?: string) => (
  <div
    title={hint}
    style={{ display: "flex", justifyContent: "space-between", padding: "8px", backgroundColor: "#1e1b3a", borderRadius: "4px", cursor: hint ? "help" : "default" }}
  >
    <span style={{ color: "#c4b5fd", fontSize: "0.75rem" }}>
      {label}
      {hint && <span style={{ color: "#6d6494", marginLeft: 4 }}>ⓘ</span>}
    </span>
    <strong style={{ color }}>{value}</strong>
  </div>
);

// mm:ss từ giây.
const fmtSec = (s: number) => {
  const sec = Math.max(0, Math.round(s));
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
};

const SPEEDS = [1, 5, 10, 30, 60];

export const ControlPanelPlayback: React.FC<ControlPanelPlaybackProps> = ({
  vehicleTotal,
  durationSec,
  genMs,
  isReady,
  isPlaying,
  togglePlay,
  currentTime,
  onScrub,
  speed,
  setSpeed,
  collisionCount,
  checkCount,
  fps,
  totalEvents,
  alerts,
  measureMode,
  toggleMeasure,
  measureInfo,
}) => {
  // Brute-force N²/2 để đối chiếu hiệu quả của spatial grid.
  const bruteForce = (vehicleTotal * (vehicleTotal - 1)) / 2;

  return (
    <div
      style={{
        width: "340px",
        padding: "10px",
        backgroundColor: "#0f0a1f",
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
        <h2 style={{ margin: "0 0 5px 0", fontSize: "1.25rem", color: "#a78bfa" }}>History Playback</h2>
        <p style={{ margin: 0, fontSize: "0.85rem", color: "#c4b5fd" }}>
          Tua lại {vehicleTotal.toLocaleString()} xe · cửa sổ {durationSec}s · phát hiện va chạm &lt; {PROXIMITY_M}m
        </p>
      </div>

      <hr style={{ borderColor: "#3b2f63", margin: 0 }} />

      {/* --- Playback controller --- */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <button
          onClick={togglePlay}
          disabled={!isReady}
          style={{
            width: "52px",
            height: "40px",
            borderRadius: "8px",
            border: "none",
            cursor: isReady ? "pointer" : "not-allowed",
            backgroundColor: isReady ? "#7c3aed" : "#3b2f63",
            color: "#fff",
            fontSize: "1.1rem",
            fontWeight: 700,
          }}
        >
          {isPlaying ? "⏸" : "▶"}
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8rem", fontVariantNumeric: "tabular-nums", marginBottom: "2px" }}>
            <strong style={{ color: "#ddd6fe" }}>{fmtSec(currentTime)}</strong>
            <span style={{ color: "#8b7fb8" }}>/ {fmtSec(durationSec)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={durationSec}
            step={0.1}
            value={currentTime}
            disabled={!isReady}
            onChange={(e) => onScrub(parseFloat(e.target.value))}
            style={{ width: "100%", cursor: isReady ? "pointer" : "not-allowed", accentColor: "#a78bfa" }}
          />
        </div>
      </div>

      {/* Tốc độ tua */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "0.75rem" }}>
        <span style={{ color: "#c4b5fd", fontWeight: "bold" }}>Tốc độ tua</span>
        <div style={{ display: "flex", gap: "4px", flex: 1, justifyContent: "flex-end" }}>
          {SPEEDS.map((s) => (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              style={{
                padding: "4px 8px",
                borderRadius: "6px",
                border: "1px solid #3b2f63",
                cursor: "pointer",
                fontSize: "0.72rem",
                fontWeight: 700,
                backgroundColor: speed === s ? "#7c3aed" : "transparent",
                color: speed === s ? "#fff" : "#c4b5fd",
              }}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>
      <p style={{ margin: "-2px 0 0 0", fontSize: "0.7rem", color: "#8b7fb8", lineHeight: 1.4 }}>
        Tốc độ tua = số <strong>giây lịch sử</strong> phát mỗi <strong>giây thực</strong>. VD 10× → toàn bộ 300s xem hết trong 30s. Thanh trượt trên hiện mốc{" "}
        <strong>mm:ss</strong> trong cửa sổ {durationSec}s; kéo để nhảy tới bất kỳ giây nào (truy xuất O(1)).
      </p>

      {/* --- Thước đo khoảng cách giữa 2 xe (dùng khi Pause) --- */}
      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        <button
          onClick={toggleMeasure}
          disabled={!isReady}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "8px",
            padding: "8px",
            borderRadius: "8px",
            border: `1px solid ${measureMode ? "#facc15" : "#3b2f63"}`,
            cursor: isReady ? "pointer" : "not-allowed",
            backgroundColor: measureMode ? "#422006" : "transparent",
            color: measureMode ? "#fde047" : "#c4b5fd",
            fontSize: "0.8rem",
            fontWeight: 700,
          }}
        >
          📏 Thước đo {measureMode ? "(ĐANG BẬT)" : ""}
        </button>
        {measureMode &&
          (measureInfo ? (
            <div style={{ padding: "8px 10px", backgroundColor: "#1c1917", border: "1px solid #facc15", borderRadius: "6px", fontSize: "0.78rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "2px" }}>
                <span style={{ color: "#a3e635", fontWeight: 700 }}>● {driverName(measureInfo.a)}</span>
                <span style={{ color: "#fb923c", fontWeight: 700 }}>{driverName(measureInfo.b)} ●</span>
              </div>
              <div style={{ textAlign: "center", color: "#fde047", fontWeight: 800, fontSize: "1.05rem", fontVariantNumeric: "tabular-nums" }}>
                {measureInfo.dist >= 1000 ? `${(measureInfo.dist / 1000).toFixed(2)} km` : `${measureInfo.dist.toFixed(1)} m`}
              </div>
            </div>
          ) : (
            <p style={{ margin: 0, fontSize: "0.74rem", color: "#fcd34d", lineHeight: 1.4 }}>
              Đã tạm dừng. Bấm lần lượt <strong>2 xe</strong> trên bản đồ để đo khoảng cách. Bấm xe thứ 3 để đo cặp mới.
            </p>
          ))}
      </div>

      <hr style={{ borderColor: "#3b2f63", margin: 0 }} />

      {/* Chỉ số live — rê chuột vào ⓘ để xem giải thích */}
      <div style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "0.75rem" }}>
        {statBox(
          "Cặp đang va chạm gần:",
          collisionCount.toLocaleString(),
          collisionCount > 0 ? "#ef4444" : "#4ade80",
          `Số cặp xe TỨC THỜI đang cách nhau < ${PROXIMITY_M}m tại đúng khung hình đang xem. Lên/xuống liên tục khi tua — bằng 0 nghĩa là khoảnh khắc này không có nguy cơ va chạm.`,
        )}
        {statBox(
          "Tổng sự kiện đã ghi:",
          totalEvents.toLocaleString(),
          "#fbbf24",
          "Tổng cộng dồn số lần một cặp xe MỚI lại gần dưới ngưỡng (chỉ đếm lúc bắt đầu lại gần, không đếm lại mỗi frame xe vẫn đang gần). Chỉ tăng khi đang phát; tua tay không sinh sự kiện.",
        )}
        {statBox(
          "Phép so cặp / frame:",
          checkCount.toLocaleString(),
          "#34d399",
          "Số phép so khoảng cách THỰC SỰ mà spatial grid phải chạy ở khung hình này (chỉ so các xe cùng ô lưới hoặc ô kề). Đây là bằng chứng hiệu năng: thường vài nghìn, so với ~12,5 triệu cặp nếu quét O(N²).",
        )}
        {statBox(
          "FPS:",
          fps,
          fps >= 50 ? "#4ade80" : fps >= 30 ? "#fbbf24" : "#ef4444",
          "Tốc độ khung hình thực đo của vòng requestAnimationFrame (publish ~2Hz). Mục tiêu 60 FPS — đo cả nội suy vị trí lẫn dò va chạm + setData mỗi frame.",
        )}
        {statBox(
          "Thời gian dựng cube:",
          `${genMs} ms`,
          "#fff",
          "Thời gian Worker mất để sinh toàn bộ khối không-thời gian (5.000 xe × 301 mốc giây) MỘT LẦN lúc mở dashboard, rồi transfer zero-copy sang main thread. Sau đó việc tua không tốn thêm chi phí sinh dữ liệu.",
        )}
      </div>

      {/* Hiệu quả spatial grid */}
      <div style={{ padding: "10px", backgroundColor: "#052e1b", borderRadius: "6px", fontSize: "0.75rem", lineHeight: 1.5, color: "#a7f3d0" }}>
        ⚡ <strong>Spatial grid:</strong> chỉ <strong style={{ color: "#34d399" }}>{checkCount.toLocaleString()}</strong> phép so khoảng cách mỗi frame,
        thay vì <strong>{bruteForce.toLocaleString()}</strong> cặp nếu quét O(N²).
      </div>

      <hr style={{ borderColor: "#3b2f63", margin: 0 }} />

      {/* Log cảnh báo va chạm gần */}
      <div style={{ display: "flex", flexDirection: "column", gap: "8px", flex: 1, minHeight: 0 }}>
        <h3 style={{ margin: 0, fontSize: "0.75rem", color: "#fecaca" }}>
          🚨 Cảnh báo va chạm gần{" "}
          {totalEvents > 0 && (
            <span style={{ color: "#c4b5fd", fontWeight: 400 }}>
              ({totalEvents.toLocaleString()} sự kiện · {Math.min(alerts.length, 60)} gần nhất)
            </span>
          )}
        </h3>
        <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: "4px", paddingRight: "4px" }}>
          {alerts.length === 0 ? (
            <p style={{ margin: 0, fontSize: "0.8rem", color: "#8b7fb8" }}>Chưa có pha lại gần nào. Bấm ▶ để tua...</p>
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
                  fontSize: "0.72rem",
                  backgroundColor: "#450a0a",
                  borderLeft: "3px solid #ef4444",
                }}
              >
                <span style={{ fontWeight: 700, color: "#f87171" }}>⚠</span>
                <span style={{ color: "#e5e7eb", flex: 1 }}>
                  {driverName(a.i)} ↔ {driverName(a.j)} · {a.dist.toFixed(1)}m
                </span>
                <span style={{ color: "#8b7fb8", fontVariantNumeric: "tabular-nums" }}>{fmtSec(a.sec)}</span>
              </div>
            ))
          )}
        </div>
      </div>

      <div style={{ fontSize: "0.72rem", color: "#8b7fb8", lineHeight: 1.4 }}>
        <p style={{ margin: 0 }}>
          🧊 <strong>Cube không-thời gian:</strong> 1 <code>Float32Array</code> phẳng (~12MB) cho cả lịch sử, truy xuất frame O(1).
          Tua nội suy 60 FPS qua <code>requestAnimationFrame</code> + <code>setData</code>. Va chạm dò bằng spatial hash grid mỗi frame.
        </p>
      </div>
    </div>
  );
};
