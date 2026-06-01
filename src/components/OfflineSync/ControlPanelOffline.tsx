import React from "react";
import type { DrawMode } from "./MapContainerOffline";
import type { OfflineFeature } from "../../utils/indexedDbHelper";
import type { SyncMode } from "../../utils/syncTransport";

interface ControlPanelOfflineProps {
  clientId: string;
  mode: SyncMode;
  setMode: (m: SyncMode) => void;
  backendConnected: boolean;
  isOnline: boolean;
  toggleNetwork: () => void;
  drawMode: DrawMode;
  setDrawMode: (m: DrawMode) => void;
  draftNote: string;
  setDraftNote: (s: string) => void;
  queueCount: number;
  syncedCount: number;
  cachedTiles: number;
  isSyncing: boolean;
  prefetch: { done: number; total: number } | null;
  conflicts: OfflineFeature[];
  selected: OfflineFeature | null;
  hint: string;
  onForceSync: () => void;
  onPrefetch: () => void;
  onSimulateServerEdit: () => void;
  onSaveNote: (note: string) => void;
  onDelete: () => void;
  onResolve: (id: string, choice: "local" | "server") => void;
  onClearSelection: () => void;
}

const DRAW_MODES: { id: DrawMode; label: string }[] = [
  { id: "select", label: "Chọn" },
  { id: "point", label: "Chấm điểm" },
  { id: "polygon", label: "Vẽ vùng" },
];

const card: React.CSSProperties = { padding: "10px", backgroundColor: "#292524", borderRadius: "4px" };

export const ControlPanelOffline: React.FC<ControlPanelOfflineProps> = ({
  clientId,
  mode,
  setMode,
  backendConnected,
  isOnline,
  toggleNetwork,
  drawMode,
  setDrawMode,
  draftNote,
  setDraftNote,
  queueCount,
  syncedCount,
  cachedTiles,
  isSyncing,
  prefetch,
  conflicts,
  selected,
  hint,
  onForceSync,
  onPrefetch,
  onSimulateServerEdit,
  onSaveNote,
  onDelete,
  onResolve,
  onClearSelection,
}) => {
  // Note hiển thị trong ô editor lấy theo feature đang chọn.
  const [editNote, setEditNote] = React.useState<string>("");
  React.useEffect(() => {
    setEditNote(selected?.properties.note ?? "");
  }, [selected]);

  return (
    <div
      style={{
        width: "340px",
        padding: "18px",
        backgroundColor: "#1c1917",
        color: "#f5f5f4",
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
        <h2 style={{ margin: "0 0 4px 0", fontSize: "1.2rem", color: "#ea580c" }}>Offline Data Core</h2>
        <p style={{ margin: 0, fontSize: "0.82rem", color: "#a8a29e" }}>IndexedDB · Tile Cache · Sync Queue</p>
        {clientId && (
          <div style={{ marginTop: 6, fontSize: "0.72rem", color: "#a8a29e" }}>
            🖥️ Máy này: <strong style={{ color: "#38bdf8", fontFamily: "monospace" }}>{clientId.slice(0, 6)}</strong>
            <span style={{ color: "#57534e" }}> (mỗi tab = 1 máy)</span>
          </div>
        )}
      </div>

      {/* Chế độ đồng bộ: Local (đa-tab) vs Backend (đa-máy) */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: "0.82rem", color: "#a8a29e", fontWeight: "bold" }}>Chế độ đồng bộ</span>
        <div style={{ display: "flex", gap: 4, backgroundColor: "#0c0a09", padding: 4, borderRadius: 8 }}>
          {(["local", "backend"] as const).map((m) => {
            const active = mode === m;
            return (
              <button
                key={m}
                onClick={() => setMode(m)}
                style={{ flex: 1, padding: "6px 4px", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600, fontSize: "0.78rem", color: active ? "#1c1917" : "#a8a29e", backgroundColor: active ? "#ea580c" : "transparent" }}
              >
                {m === "local" ? "Local (đa-tab)" : "Backend (đa-máy)"}
              </button>
            );
          })}
        </div>
        {mode === "backend" && (
          <small style={{ color: backendConnected ? "#22c55e" : "#ef4444" }}>
            {backendConnected ? "🟢 Đã kết nối backend" : "🔴 Chưa kết nối — chạy `npm run server`"}
          </small>
        )}
      </div>

      {/* Trạng thái mạng */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>
          Mạng:
          <strong style={{ color: isOnline ? "#22c55e" : "#ef4444", marginLeft: 6 }}>{isOnline ? "ONLINE" : "OFFLINE"}</strong>
        </span>
        <button
          onClick={toggleNetwork}
          style={{ padding: "6px 12px", borderRadius: 4, border: "none", cursor: "pointer", fontWeight: "bold", backgroundColor: isOnline ? "#ef4444" : "#22c55e", color: "#fff" }}
        >
          {isOnline ? "Go Offline" : "Go Online"}
        </button>
      </div>

      <hr style={{ borderColor: "#292524", margin: 0 }} />

      {/* Công cụ vẽ + ghi chú */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: "0.92rem" }}>Công cụ khảo sát</h3>
        <div style={{ display: "flex", gap: 4, backgroundColor: "#0c0a09", padding: 4, borderRadius: 8 }}>
          {DRAW_MODES.map(({ id, label }) => {
            const active = drawMode === id;
            return (
              <button
                key={id}
                onClick={() => setDrawMode(id)}
                style={{ flex: 1, padding: "6px 4px", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600, fontSize: "0.78rem", color: active ? "#1c1917" : "#a8a29e", backgroundColor: active ? "#ea580c" : "transparent" }}
              >
                {label}
              </button>
            );
          })}
        </div>
        <input
          value={draftNote}
          onChange={(e) => setDraftNote(e.target.value)}
          placeholder="Ghi chú cho điểm/vùng sắp tạo..."
          style={{ padding: "8px", borderRadius: 4, border: "1px solid #44403c", backgroundColor: "#0c0a09", color: "#f5f5f4", fontSize: "0.82rem" }}
        />
        <small style={{ color: "#78716c", lineHeight: 1.4 }}>
          {drawMode === "polygon"
            ? "Click để thêm đỉnh, click lại vào đỉnh đầu để đóng vùng."
            : drawMode === "point"
              ? "Click lên bản đồ để chấm điểm khảo sát."
              : "Click vào điểm/vùng để chọn & xem chi tiết."}
        </small>
      </div>

      <hr style={{ borderColor: "#292524", margin: 0 }} />

      {/* Offline map cache */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: "0.92rem" }}>Bản đồ Offline (Tile Cache)</h3>
        <div style={{ ...card, display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: "#a8a29e", fontSize: "0.85rem" }}>Tiles đã cache</span>
          <strong style={{ color: "#38bdf8" }}>{cachedTiles}</strong>
        </div>
        <button
          onClick={onPrefetch}
          disabled={!!prefetch}
          style={{ padding: "9px", backgroundColor: "#0369a1", color: "#fff", border: "none", borderRadius: 4, cursor: prefetch ? "default" : "pointer", fontWeight: "bold", opacity: prefetch ? 0.7 : 1 }}
        >
          {prefetch ? `Đang tải ${prefetch.done}/${prefetch.total}...` : "📥 Tải vùng này về máy"}
        </button>
        <small style={{ color: "#78716c", lineHeight: 1.4 }}>
          Vùng bạn đã xem khi online được tự lưu lại; hoặc tải trước cả viewport để xem khi mất mạng.
        </small>
      </div>

      <hr style={{ borderColor: "#292524", margin: 0 }} />

      {/* Hàng đợi đồng bộ */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h3 style={{ margin: 0, fontSize: "0.92rem", color: "#cbd5e1" }}>
          Hàng đợi đồng bộ {isSyncing && <span style={{ color: "#38bdf8", fontSize: "0.78rem" }}>· đang sync…</span>}
        </h3>
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ ...card, flex: 1, textAlign: "center" }}>
            <span style={{ fontSize: "0.78rem", color: "#a8a29e", display: "block" }}>Chờ sync</span>
            <strong style={{ fontSize: "1.4rem", color: queueCount > 0 ? "#f97316" : "#a8a29e" }}>{queueCount}</strong>
          </div>
          <div style={{ ...card, flex: 1, textAlign: "center" }}>
            <span style={{ fontSize: "0.78rem", color: "#a8a29e", display: "block" }}>Đã sync</span>
            <strong style={{ fontSize: "1.4rem", color: "#22c55e" }}>{syncedCount}</strong>
          </div>
          <div style={{ ...card, flex: 1, textAlign: "center" }}>
            <span style={{ fontSize: "0.78rem", color: "#a8a29e", display: "block" }}>Conflict</span>
            <strong style={{ fontSize: "1.4rem", color: conflicts.length > 0 ? "#ef4444" : "#a8a29e" }}>{conflicts.length}</strong>
          </div>
        </div>

        {!isOnline && queueCount > 0 && (
          <div style={{ fontSize: "0.78rem", color: "#f97316", backgroundColor: "#451a03", padding: 8, borderRadius: 4, lineHeight: 1.4 }}>
            ⚠️ Đang lưu tạm ở IndexedDB. Bật mạng lại để tự đồng bộ.
          </div>
        )}
        {isOnline && queueCount > 0 && (
          <button onClick={onForceSync} style={{ padding: 9, backgroundColor: "#ea580c", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer", fontWeight: "bold" }}>
            🚀 Sync ngay ({queueCount})
          </button>
        )}
      </div>

      {/* Xử lý xung đột */}
      {conflicts.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: "0.92rem", color: "#ef4444" }}>⚠️ Xung đột dữ liệu</h3>
          {conflicts.map((f) => (
            <div key={f.id} style={{ ...card, border: "1px solid #7f1d1d", display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: "0.78rem", color: "#a8a29e" }}>
                <div>📱 Của bạn: <strong style={{ color: "#fbbf24" }}>{f.properties.note}</strong></div>
                <div>☁️ Server (v{f.properties.serverVersion}): <strong style={{ color: "#60a5fa" }}>{f.properties.serverNote}</strong></div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => onResolve(f.id, "local")} style={{ flex: 1, padding: 6, backgroundColor: "#ca8a04", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer", fontSize: "0.78rem", fontWeight: 600 }}>
                  Giữ bản của tôi
                </button>
                <button onClick={() => onResolve(f.id, "server")} style={{ flex: 1, padding: 6, backgroundColor: "#2563eb", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer", fontSize: "0.78rem", fontWeight: 600 }}>
                  Lấy bản server
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Chi tiết feature đang chọn + sửa ghi chú (để tạo conflict demo) */}
      {selected && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ margin: 0, fontSize: "0.92rem" }}>Đang chọn: {selected.properties.kind === "point" ? "Điểm" : "Vùng"}</h3>
            <button onClick={onClearSelection} style={{ background: "none", border: "none", color: "#a8a29e", cursor: "pointer", fontSize: "0.8rem" }}>
              ✕ Bỏ chọn
            </button>
          </div>
          <textarea
            value={editNote}
            onChange={(e) => setEditNote(e.target.value)}
            rows={2}
            style={{ padding: 8, borderRadius: 4, border: "1px solid #44403c", backgroundColor: "#0c0a09", color: "#f5f5f4", fontSize: "0.82rem", resize: "vertical" }}
          />
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => onSaveNote(editNote)} style={{ flex: 1, padding: 8, backgroundColor: "#16a34a", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer", fontWeight: 600, fontSize: "0.82rem" }}>
              💾 Lưu ghi chú
            </button>
            <button onClick={onDelete} style={{ padding: "8px 12px", backgroundColor: "#7f1d1d", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer", fontWeight: 600, fontSize: "0.82rem" }}>
              🗑 Xoá
            </button>
          </div>
        </div>
      )}

      {hint && (
        <div style={{ fontSize: "0.78rem", color: "#bef264", backgroundColor: "#1a2e05", padding: 8, borderRadius: 4, lineHeight: 1.4 }}>{hint}</div>
      )}

      {/* Công cụ giả lập conflict */}
      <button
        onClick={onSimulateServerEdit}
        style={{ marginTop: "auto", padding: 8, backgroundColor: "transparent", color: "#a8a29e", border: "1px dashed #44403c", borderRadius: 4, cursor: "pointer", fontSize: "0.78rem" }}
      >
        🧪 Giả lập đồng nghiệp sửa trên server
      </button>
    </div>
  );
};
