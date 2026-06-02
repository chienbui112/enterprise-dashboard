import React, { useEffect, useRef, useState } from "react";
import { createFloodSensorFeed, type FeedStatus, type FloodSensorFeedHandle } from "../../utils/floodSensorFeed";
import { BASEMAP_OPTIONS, type SceneSource, type TilesStatus, type BasemapId } from "./MapContainerFlood";

type LevelMode = "manual" | "iot";

interface ControlPanelFloodProps {
  initialLevel: number;
  // Ghi mực nước vào nguồn sự thật (ref ở component cha) — không gây re-render.
  onSetLevel: (meters: number) => void;
  isProcessing: boolean;
  genMs: number;
  buildingCount: number;
  treeCount: number;
  barrierCount: number;
  onRegenerate: () => void;
  // Nguồn cảnh 3D + DEM (Phase B/C)
  sceneSource: SceneSource;
  onSceneSource: (s: SceneSource) => void;
  terrainOn: boolean;
  onTerrainOn: (v: boolean) => void;
  terrainExaggeration: number;
  onTerrainExaggeration: (v: number) => void;
  tilesStatus: TilesStatus;
  basemap: BasemapId;
  onBasemap: (b: BasemapId) => void;
}

const MAX_LEVEL = 5; // mét

export const ControlPanelFlood: React.FC<ControlPanelFloodProps> = ({
  initialLevel,
  onSetLevel,
  isProcessing,
  genMs,
  buildingCount,
  treeCount,
  barrierCount,
  onRegenerate,
  sceneSource,
  onSceneSource,
  terrainOn,
  onTerrainOn,
  terrainExaggeration,
  onTerrainExaggeration,
  tilesStatus,
  basemap,
  onBasemap,
}) => {
  // Ref tới chính DOM của Slider + nhãn số: cập nhật trực tiếp, KHÔNG setState
  // -> giá trị bơm thẳng vào uniform GPU, không kích hoạt re-render của React.
  const sliderRef = useRef<HTMLInputElement>(null);
  const valueLabelRef = useRef<HTMLSpanElement>(null);
  const levelRef = useRef(initialLevel); // mirror cục bộ để kịch bản bão tự tăng dần
  const stormTimerRef = useRef<number | null>(null);
  const [storming, setStorming] = useState(false);

  // Nguồn điều khiển mực nước: "manual" (slider + bão) hay "iot" (feed cảm biến WebSocket).
  // mode là state HỢP LỆ: chỉ đổi khi người dùng bấm toggle (hiếm) -> cần re-render panel để
  // đổi chip trạng thái + khoá slider. KHÔNG phải cập nhật mỗi frame nên không ảnh hưởng map.
  const [mode, setMode] = useState<LevelMode>("manual");
  const [feedStatus, setFeedStatus] = useState<FeedStatus>("connecting");
  const feedRef = useRef<FloodSensorFeedHandle | null>(null);
  const stationRef = useRef<string>("");

  // Ghi mực nước vào nguồn sự thật + đồng bộ DOM (slider thumb + nhãn). Không qua state.
  const setLevel = (v: number) => {
    const clamped = Math.max(0, Math.min(MAX_LEVEL, v));
    levelRef.current = clamped;
    onSetLevel(clamped); // cha mutate ref.current.meters -> custom WebGL layer đọc ngay
    if (sliderRef.current) sliderRef.current.value = String(clamped);
    if (valueLabelRef.current) valueLabelRef.current.textContent = clamped.toFixed(1);
  };
  // Feed cảm biến được tạo trong effect (1 lần khi vào mode iot); mirror setLevel qua ref để
  // callback luôn gọi bản mới nhất, tránh stale closure (ref-for-prop pattern của repo).
  const setLevelRef = useRef(setLevel);
  setLevelRef.current = setLevel;

  const stopStorm = () => {
    if (stormTimerRef.current !== null) {
      window.clearInterval(stormTimerRef.current);
      stormTimerRef.current = null;
    }
    setStorming(false);
  };

  // Kéo tay -> dừng kịch bản bão, ghi thẳng giá trị. (Ở mode IoT slider bị khoá; guard thêm.)
  const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (mode === "iot") return;
    stopStorm();
    setLevel(parseFloat(e.target.value));
  };

  // Vòng đời feed cảm biến IoT: chỉ chạy khi mode === "iot". Vào mode -> dừng bão, mở feed
  // (tự fallback mô phỏng nếu không có backend). Rời mode / unmount -> stop() sạch.
  useEffect(() => {
    if (mode !== "iot") return;
    stopStorm();
    setFeedStatus("connecting");
    const handle = createFloodSensorFeed({
      onReading: (lv) => setLevelRef.current(lv), // dùng CHUNG setLevel -> đồng bộ uniform + DOM
      onStatus: (s, station) => {
        setFeedStatus(s);
        if (station) stationRef.current = station;
      },
    });
    feedRef.current = handle;
    return () => {
      handle.stop();
      feedRef.current = null;
    };
  }, [mode]);

  // Kịch bản "Bão về": nước dâng thật chậm 0 -> 5m, mỗi 120ms +0.012m (~50s), rồi tự dừng.
  const toggleStorm = () => {
    if (storming) {
      stopStorm();
      return;
    }
    setStorming(true);
    if (levelRef.current >= MAX_LEVEL) setLevel(0);
    stormTimerRef.current = window.setInterval(() => {
      const next = levelRef.current + 0.012;
      setLevel(next);
      if (next >= MAX_LEVEL) stopStorm();
    }, 120);
  };

  // Dọn timer khi unmount.
  useEffect(() => () => stopStorm(), []);

  const panelBtn = (bg: string): React.CSSProperties => ({
    padding: "10px",
    backgroundColor: bg,
    color: "#fff",
    border: "none",
    borderRadius: 4,
    cursor: isProcessing ? "not-allowed" : "pointer",
    fontWeight: "bold",
    opacity: isProcessing ? 0.5 : 1,
  });

  const metric = (label: string, value: string, color: string) => (
    <div style={{ display: "flex", justifyContent: "space-between", padding: 8, backgroundColor: "#1e293b", borderRadius: 4 }}>
      <span style={{ color: "#94a3b8", fontSize: "0.9rem" }}>{label}</span>
      <strong style={{ color }}>{value}</strong>
    </div>
  );

  return (
    <div
      style={{
        width: 340,
        padding: 20,
        backgroundColor: "#0f172a",
        color: "#f8fafc",
        boxShadow: "4px 0 15px rgba(0,0,0,0.5)",
        zIndex: 10,
        display: "flex",
        flexDirection: "column",
        gap: 18,
        fontFamily: "sans-serif",
        overflowY: "auto",
      }}
    >
      <div>
        <h2 style={{ margin: "0 0 5px 0", fontSize: "1.25rem", color: "#38bdf8" }}>3D Digital Twin — Ngập lụt</h2>
        <p style={{ margin: 0, fontSize: "0.85rem", color: "#94a3b8" }}>
          Custom WebGL Shader · Instanced Rendering · Uniform-driven Slider
        </p>
      </div>

      <hr style={{ borderColor: "#1e293b", margin: 0 }} />

      {/* NGUỒN CẢNH 3D: Synthetic + DEM terrain  hay  Google Photorealistic 3D Tiles */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: "0.95rem", color: "#e2e8f0" }}>Nguồn cảnh 3D</h3>
        <div style={{ display: "flex", gap: 6 }}>
          {(
            [
              ["synthetic", "🏙️ Synthetic"],
              ["maptiler", "🗼 MapTiler"],
              ["google", "🌍 Google"],
            ] as [SceneSource, string][]
          ).map(([s, label]) => (
            <button
              key={s}
              onClick={() => onSceneSource(s)}
              disabled={isProcessing}
              style={{
                flex: 1,
                padding: "8px 4px",
                fontSize: "0.76rem",
                fontWeight: 600,
                backgroundColor: sceneSource === s ? "#0ea5e9" : "#1e293b",
                color: sceneSource === s ? "#fff" : "#94a3b8",
                border: `1px solid ${sceneSource === s ? "#0ea5e9" : "#334155"}`,
                borderRadius: 4,
                cursor: isProcessing ? "not-allowed" : "pointer",
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {sceneSource === "google" ? (
          (() => {
            const meta: Record<TilesStatus, [string, string]> = {
              idle: ["#64748b", "● Sẵn sàng"],
              loading: ["#d97706", "● Đang tải 3D Tiles từ Google…"],
              ready: ["#16a34a", "● 3D Tiles đã tải (HLOD theo SSE)"],
              error: ["#ef4444", "● Lỗi tải tiles — bật Map Tiles API / kiểm tra key"],
            };
            const [color, label] = meta[tilesStatus];
            return (
              <div style={{ padding: 8, backgroundColor: "#1e293b", borderRadius: 4, fontSize: "0.78rem", lineHeight: 1.4 }}>
                <span style={{ color, fontWeight: 600 }}>{label}</span>
                <div style={{ color: "#64748b", marginTop: 4 }}>
                  Photogrammetry thật (OGC 3D Tiles, deck.gl); mặt nước dùng chung depth buffer nên ngập theo cao độ thật.
                </div>
              </div>
            );
          })()
        ) : (
          <>
            {sceneSource === "maptiler" && (
              <div style={{ padding: 8, backgroundColor: "#1e293b", borderRadius: 4, fontSize: "0.76rem", color: "#64748b", lineHeight: 1.4 }}>
                Nhà 3D thật từ <strong style={{ color: "#cbd5e1" }}>MapTiler</strong> (OpenMapTiles vector ·
                <code> fill-extrusion</code>). Nếu trống/lỗi: key MapTiler bị giới hạn origin — thêm origin vào
                allowlist tại cloud.maptiler.com.
              </div>
            )}
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "0.82rem", color: "#cbd5e1" }}>
              <input type="checkbox" checked={terrainOn} onChange={(e) => onTerrainOn(e.target.checked)} />
              Địa hình DEM thật (raster-dem · Terrarium) — nước ngập theo cao độ
            </label>
            {terrainOn && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "0.78rem", color: "#94a3b8" }}>
                <span>Phóng đại</span>
                <input
                  type="range"
                  min={1}
                  max={3}
                  step={0.1}
                  value={terrainExaggeration}
                  onChange={(e) => onTerrainExaggeration(parseFloat(e.target.value))}
                  style={{ flex: 1, accentColor: "#0ea5e9" }}
                />
                <span>×{terrainExaggeration.toFixed(1)}</span>
              </div>
            )}
          </>
        )}
      </div>

      {/* BẢN ĐỒ NỀN (basemap) — tối / sáng */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: "0.82rem", color: "#cbd5e1" }}>Bản đồ nền</span>
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

      <hr style={{ borderColor: "#1e293b", margin: 0 }} />

      {/* NGUỒN ĐIỀU KHIỂN: Cảm biến IoT (WebSocket) hay Thủ công */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: "0.95rem", color: "#e2e8f0" }}>Nguồn mực nước</h3>
        <div style={{ display: "flex", gap: 6 }}>
          {(
            [
              ["iot", "📡 Cảm biến IoT"],
              ["manual", "✋ Thủ công"],
            ] as [LevelMode, string][]
          ).map(([m, label]) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              disabled={isProcessing}
              style={{
                flex: 1,
                padding: "8px",
                backgroundColor: mode === m ? "#0ea5e9" : "#1e293b",
                color: mode === m ? "#fff" : "#94a3b8",
                border: `1px solid ${mode === m ? "#0ea5e9" : "#334155"}`,
                borderRadius: 4,
                cursor: isProcessing ? "not-allowed" : "pointer",
                fontWeight: 600,
                fontSize: "0.8rem",
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {mode === "iot" &&
          (() => {
            const meta: Record<FeedStatus, [string, string]> = {
              connecting: ["#64748b", "● Đang kết nối trạm đo…"],
              live: ["#16a34a", "● LIVE — dữ liệu cảm biến thật"],
              simulated: ["#d97706", "● MÔ PHỎNG — không có backend"],
            };
            const [color, label] = meta[feedStatus];
            return (
              <div style={{ display: "flex", justifyContent: "space-between", padding: 8, backgroundColor: "#1e293b", borderRadius: 4, fontSize: "0.8rem" }}>
                <span style={{ color, fontWeight: 600 }}>{label}</span>
                <span style={{ color: "#94a3b8" }}>{stationRef.current || "—"}</span>
              </div>
            );
          })()}
      </div>

      <hr style={{ borderColor: "#1e293b", margin: 0 }} />

      {/* SLIDER ĐIỀU KHIỂN MỰC NƯỚC — bơm thẳng vào uniform u_water_level */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h3 style={{ margin: 0, fontSize: "0.95rem", color: "#e2e8f0" }}>
          Mức độ ngập lụt:{" "}
          <span ref={valueLabelRef} style={{ color: "#38bdf8" }}>
            {initialLevel.toFixed(1)}
          </span>{" "}
          m
        </h3>
        <input
          ref={sliderRef}
          type="range"
          min={0}
          max={MAX_LEVEL}
          step={0.1}
          defaultValue={initialLevel}
          onChange={handleInput}
          disabled={isProcessing || mode === "iot"}
          style={{ width: "100%", accentColor: "#0ea5e9", opacity: mode === "iot" ? 0.6 : 1 }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: "#64748b" }}>
          <span>0 m</span>
          <span>2.5 m</span>
          <span>5 m</span>
        </div>
        <button
          onClick={toggleStorm}
          disabled={isProcessing || mode === "iot"}
          style={{ ...panelBtn(storming ? "#ef4444" : "#0ea5e9"), opacity: isProcessing || mode === "iot" ? 0.5 : 1 }}
        >
          {storming ? "■ Dừng kịch bản bão" : "🌊 Mô phỏng bão về (0 → 5m)"}
        </button>
        <p style={{ margin: 0, fontSize: "0.75rem", color: "#64748b", lineHeight: 1.4 }}>
          {mode === "iot" ? (
            <>
              Mực nước do <strong>cảm biến IoT</strong> bắn về qua <code>WebSocket</code> → đẩy thẳng vào uniform{" "}
              <code>u_water_level</code> của GPU Shader (Slider tự chạy theo, không re-render map). Chuyển{" "}
              <strong>Thủ công</strong> để tự kéo.
            </>
          ) : (
            <>
              Kéo Slider hoặc chạy kịch bản: giá trị đi thẳng vào biến <code>u_water_level</code> của GPU Shader,
              không kích hoạt vòng re-render React. Phần thân nhà / cây / rào nằm dưới mực nước sẽ bị nhuộm xanh.
            </>
          )}
          <br />
          <em>Lưu ý: cao độ nước được phóng đại ×4 cho dễ quan sát (Slider vẫn là mét thật).</em>
        </p>
      </div>

      <hr style={{ borderColor: "#1e293b", margin: 0 }} />

      {/* CHỈ SỐ CẢNH */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h3 style={{ margin: 0, fontSize: "1rem", color: "#e2e8f0" }}>Thành phần cảnh (Scene)</h3>
        {metric("Toà nhà (fill-extrusion):", buildingCount.toLocaleString(), "#f8fafc")}
        {metric("Cây xanh (instanced):", treeCount.toLocaleString(), "#4ade80")}
        {metric("Rào chắn (instanced):", barrierCount.toLocaleString(), "#fb923c")}
        {metric("Worker sinh cảnh:", genMs > 0 ? `${genMs.toFixed(1)} ms` : "…", "#38bdf8")}
        {metric("Tổng vật thể props:", (treeCount + barrierCount).toLocaleString(), "#a855f7")}
      </div>

      <button onClick={onRegenerate} disabled={isProcessing} style={panelBtn("#6366f1")}>
        ↻ Sinh lại bản sao số đô thị
      </button>

      <div style={{ marginTop: "auto", fontSize: "0.78rem", color: "#64748b", lineHeight: 1.5 }}>
        <strong>Kiến trúc:</strong> Mặt nước là một lưới 128×128 đỉnh do Vertex Shader dập sóng (GPU, 60 FPS).
        Cây &amp; rào dùng <strong>Instanced Rendering</strong> — 1 base-mesh dùng chung cho hàng nghìn vật thể,
        chỉ tốn 1 VBO instance nhỏ nên không tràn VRAM. Nghiêng/xoay bằng <strong>chuột phải + kéo</strong>.
      </div>
    </div>
  );
};
