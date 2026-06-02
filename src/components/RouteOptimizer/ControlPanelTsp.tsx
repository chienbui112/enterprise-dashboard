import React from "react";
import type { DeliveryPoint } from "../../utils/routeApiHelper";

export type SolveStatus = "idle" | "matrix" | "solving" | "routing" | "done";
export type RoutingSource = "OSRM" | "fallback";

// Kết quả CUỐI CÙNG đã tối ưu — đây là dữ liệu duy nhất nằm trong React state.
export interface TspResult {
  ordered: (DeliveryPoint & { rank: number })[]; // điểm theo thứ tự thăm (rank 0 = kho)
  distanceKm: number; // tổng quãng đường chu trình đóng (gồm chặng về kho)
  durationMin: number; // tổng thời gian di chuyển ước tính (phút)
  nnKm: number; // độ dài Nearest Neighbor thuần
  twoOptKm: number; // sau 2-opt
  exactKm: number | null; // Held-Karp (null nếu N quá lớn để giải chính xác)
  optimal: boolean; // true nếu có lời giải tối ưu tuyệt đối
  routingSource: RoutingSource; // OSRM (đường thật) hay fallback (giả lập)
}

interface ControlPanelTspProps {
  status: SolveStatus;
  result: TspResult | null;
  pointCount: number;
  showCompare: boolean;
  setShowCompare: (v: boolean) => void;
  onOptimize: () => void;
  onRegenerate: () => void;
}

const ACCENT = "#818cf8";

const statusText: Record<SolveStatus, string> = {
  idle: "Sẵn sàng — bấm Tối ưu lộ trình",
  matrix: "🛰️ Lấy ma trận khoảng cách thật từ OSRM /table...",
  solving: "⚙️ Worker đang giải TSP (NN → 2-opt → Held-Karp)...",
  routing: "🛣️ Lấy hình học đường thật từ OSRM /route...",
  done: "✅ Đã tối ưu xong lộ trình",
};

// km gọn: tổng (m) -> km.
const km = (v: number) => (v / 1000).toFixed(2);

export const ControlPanelTsp: React.FC<ControlPanelTspProps> = ({
  status,
  result,
  pointCount,
  showCompare,
  setShowCompare,
  onOptimize,
  onRegenerate,
}) => {
  const busy = status !== "idle" && status !== "done";
  // % cải thiện của lời giải cuối so với Nearest Neighbor thuần.
  const finalCost = result ? (result.exactKm ?? result.twoOptKm) : 0;
  const improvedPct = result && result.nnKm > 0 ? ((result.nnKm - finalCost) / result.nnKm) * 100 : 0;

  return (
    <div
      style={{
        width: "340px",
        padding: "20px",
        backgroundColor: "#1e1b4b",
        color: "#f8fafc",
        boxShadow: "4px 0 15px rgba(0,0,0,0.5)",
        zIndex: 10,
        display: "flex",
        flexDirection: "column",
        gap: "16px",
        fontFamily: "sans-serif",
        height: "100vh",
        boxSizing: "border-box",
      }}
    >
      <div>
        <h2 style={{ margin: "0 0 5px 0", fontSize: "1.25rem", color: ACCENT }}>Route Optimizer</h2>
        <p style={{ margin: 0, fontSize: "0.85rem", color: "#c7d2fe" }}>
          OSRM (đường thật) · NN + 2-opt + Held-Karp
        </p>
      </div>

      <hr style={{ borderColor: "#312e81", margin: 0, width: "100%" }} />

      {/* Hành động */}
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        <button
          onClick={onOptimize}
          disabled={busy}
          style={{
            padding: "11px",
            border: "none",
            borderRadius: "8px",
            background: busy ? "#4338ca" : ACCENT,
            color: "#0f172a",
            fontWeight: 700,
            fontSize: "0.95rem",
            cursor: busy ? "wait" : "pointer",
          }}
        >
          {busy ? "Đang xử lý..." : "🚀 Tối ưu lộ trình"}
        </button>
        <button
          onClick={onRegenerate}
          disabled={busy}
          style={{
            padding: "9px",
            border: `1px solid ${ACCENT}`,
            borderRadius: "8px",
            background: "transparent",
            color: "#c7d2fe",
            fontWeight: 600,
            fontSize: "0.9rem",
            cursor: busy ? "not-allowed" : "pointer",
            opacity: busy ? 0.5 : 1,
          }}
        >
          🎲 Tạo {pointCount} điểm mới
        </button>
      </div>

      <div style={{ padding: "9px 11px", background: "#312e81", borderRadius: "6px", fontSize: "0.83rem", color: "#e0e7ff" }}>
        {statusText[status]}
      </div>

      {/* Chỉ số tổng hợp */}
      {result && (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 11px", background: "#312e81", borderRadius: "6px" }}>
            <span style={{ color: "#c7d2fe", fontSize: "0.85rem" }}>Tổng quãng đường</span>
            <strong style={{ color: "#34d399" }}>{result.distanceKm.toFixed(2)} km</strong>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 11px", background: "#312e81", borderRadius: "6px" }}>
            <span style={{ color: "#c7d2fe", fontSize: "0.85rem" }}>Thời gian ước tính</span>
            <strong style={{ color: "#fff" }}>{result.durationMin.toFixed(0)} phút</strong>
          </div>

          {/* Chuỗi cải thiện thuật toán */}
          <div style={{ padding: "9px 11px", background: "#312e81", borderRadius: "6px", fontSize: "0.8rem", color: "#c7d2fe", lineHeight: 1.6 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Nearest Neighbor</span> <span>{km(result.nnKm)} km</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>+ 2-opt</span> <span style={{ color: ACCENT }}>{km(result.twoOptKm)} km</span>
            </div>
            {result.exactKm != null && (
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>+ Held-Karp</span> <span style={{ color: "#34d399" }}>{km(result.exactKm)} km</span>
              </div>
            )}
            <div style={{ marginTop: 4, color: "#a5b4fc" }}>
              Tối ưu {improvedPct.toFixed(1)}% so với NN
              {result.optimal && <strong style={{ color: "#34d399" }}> · ✓ tối ưu tuyệt đối</strong>}
            </div>
          </div>

          {/* So sánh trực quan với Nearest Neighbor */}
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 11px",
              background: "#312e81",
              borderRadius: "6px",
              fontSize: "0.83rem",
              cursor: "pointer",
            }}
          >
            <input type="checkbox" checked={showCompare} onChange={(e) => setShowCompare(e.target.checked)} style={{ width: 16, height: 16, cursor: "pointer" }} />
            <span style={{ width: 22, height: 0, borderTop: "2px dashed #f87171", flexShrink: 0 }} />
            <span style={{ color: "#fecaca" }}>Chồng lộ trình Nearest Neighbor</span>
          </label>

          {/* Nguồn routing */}
          <div style={{ fontSize: "0.78rem", color: result.routingSource === "OSRM" ? "#34d399" : "#f59e0b" }}>
            {result.routingSource === "OSRM"
              ? "🛣️ Đường thật từ OSRM (mạng lưới giao thông)"
              : "⚠️ OSRM không kết nối được — đang dùng polyline giả lập (fallback)"}
          </div>

          {/* Chú giải đa phương thức */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.78rem", color: "#c7d2fe" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 22, height: 0, borderTop: "4px solid #22c55e" }} /> Xe máy (đường lớn)
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 22, height: 0, borderTop: "4px dashed #3b82f6" }} /> Đi bộ (chặng ngắn vào ngõ)
            </div>
            <span style={{ color: "#64748b", fontSize: "0.72rem", lineHeight: 1.4 }}>
              * OSRM demo chỉ có profile ô tô — phân loại phương thức chỉ mang tính minh hoạ render.
            </span>
          </div>
        </div>
      )}

      {/* Danh sách điểm theo thứ tự tối ưu */}
      <div style={{ display: "flex", flexDirection: "column", gap: "8px", flex: 1, minHeight: 0 }}>
        <h3 style={{ margin: 0, fontSize: "0.95rem", color: "#cbd5e1" }}>Thứ tự giao hàng tối ưu</h3>
        {result ? (
          <ol style={{ margin: 0, padding: 0, listStyle: "none", overflowY: "auto", display: "flex", flexDirection: "column", gap: "5px" }}>
            {result.ordered.map((p) => (
              <li
                key={p.rank}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                  padding: "7px 9px",
                  background: p.isDepot ? "#422006" : "#312e81",
                  borderRadius: "6px",
                  fontSize: "0.85rem",
                }}
              >
                <span
                  style={{
                    flexShrink: 0,
                    width: 24,
                    height: 24,
                    borderRadius: "50%",
                    background: p.isDepot ? "#fbbf24" : ACCENT,
                    color: "#0f172a",
                    fontWeight: 700,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "0.75rem",
                  }}
                >
                  {p.isDepot ? "K" : p.rank}
                </span>
                <span style={{ flex: 1 }}>{p.name}</span>
                <span style={{ color: "#94a3b8", fontSize: "0.72rem" }}>
                  {p.lat.toFixed(3)}, {p.lng.toFixed(3)}
                </span>
              </li>
            ))}
            <li style={{ padding: "6px 9px", fontSize: "0.78rem", color: "#94a3b8", textAlign: "center" }}>
              ↩︎ quay về Kho trung tâm
            </li>
          </ol>
        ) : (
          <p style={{ margin: 0, fontSize: "0.83rem", color: "#94a3b8", lineHeight: 1.5 }}>
            {pointCount} điểm giao hàng đang nằm rải rác trên bản đồ. Bấm <strong>Tối ưu lộ trình</strong> để
            lấy ma trận khoảng cách thật (OSRM) và để Worker tìm thứ tự đi ngắn nhất.
          </p>
        )}
      </div>

      <div style={{ fontSize: "0.78rem", color: "#6366f1", lineHeight: 1.4 }}>
        🧠 <strong>Luồng:</strong> OSRM <code>/table</code> → Worker giải TSP (không block UI) → OSRM{" "}
        <code>/route</code> → vẽ <em>line layer</em> đa phương thức trên GPU.
      </div>
    </div>
  );
};
