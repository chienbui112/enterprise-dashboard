// index.tsx — Orchestrator dashboard "3D Digital Twin Ngập lụt (CesiumJS)".
//
// Mô hình ngập theo cao độ tuyệt đối: slider/bão chỉ điều khiển MỘT mức dâng -> FloodController đặt
// W (cao độ mặt nước). Cesium.CallbackProperty trong map đọc W mỗi khung hình (60 FPS, không
// re-render). React state chỉ phục vụ UI panel (slider hiển thị, log IoT, vài chỉ số hố ga).
//
// TẠM TẮT: tô màu nhà theo ngập + cảnh báo (worker phân tích nhà không dùng cho màu lúc này).

import { useEffect, useRef, useState } from "react";
import { ControlPanelCesium, type SensorLog } from "./ControlPanelCesium";
import { MapContainerCesium, type MeasureResult, type TerrainStatus } from "./MapContainerCesium";
import { createFloodController, statusFromLevel, type BasemapId, type FloodController } from "../../utils/cesiumFloodHelpers";
import { createStormStream, type StormStreamHandle } from "../../utils/cesiumSensorFeed";

const STATS_INTERVAL_MS = 250; // nhịp làm tươi chỉ số hố ga lên panel
const LOG_ROWS = 12;

// ion token (bắt buộc cho địa hình thật). Thiếu -> nền phẳng (min=max=0), mô hình vẫn chạy.
const ION_TOKEN = (import.meta.env.VITE_CESIUM_ION_TOKEN as string | undefined) || null;

export const CesiumFloodTwinDashboard: React.FC = () => {
  // Singleton ổn định (useState lazy initializer): tạo 1 lần, đọc được khi render.
  const [controller] = useState<FloodController>(() => createFloodController());

  const stormRef = useRef<StormStreamHandle | null>(null);
  const logSeqRef = useRef(0);

  // React state cho UI panel.
  const [isReady, setIsReady] = useState(false);
  const [storming, setStorming] = useState(false);
  const [logs, setLogs] = useState<SensorLog[]>([]);
  const [riseLevel, setRiseLevel] = useState(0); // mức dâng hiện tại (m, so điểm thấp nhất)
  const [dangerStations, setDangerStations] = useState(0);
  const [warningStations, setWarningStations] = useState(0);
  const [terrainStatus, setTerrainStatus] = useState<TerrainStatus>("idle");
  const [waterRange, setWaterRange] = useState(5); // dải slider, nhận sau khi sample địa hình
  const [buildingCount, setBuildingCount] = useState({ kept: 0, total: 0 });
  const [buildingInfo, setBuildingInfo] = useState<Record<string, unknown> | null>(null);
  const [waterEffect, setWaterEffect] = useState(true); // bật lớp shimmer Water Material (sóng + specular)
  const [basemap, setBasemap] = useState<BasemapId>("dark");
  const [measureMode, setMeasureMode] = useState(false);
  const [measureResult, setMeasureResult] = useState<MeasureResult | null>(null);

  // Làm tươi chỉ số hố ga (suy từ độ sâu = W - cao độ đất tại trạm). Không đụng tới map.
  useEffect(() => {
    const timer = window.setInterval(() => {
      let danger = 0;
      let warning = 0;
      for (let i = 0; i < controller.stations.length; i++) {
        const code = controller.sensorStatusCode(i);
        if (code === 2) danger++;
        else if (code === 1) warning++;
      }
      setDangerStations(danger);
      setWarningStations(warning);
      setRiseLevel(Math.max(0, controller.waterElevation - controller.minTerrain));
    }, STATS_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      stormRef.current?.stop();
      stormRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Slider thủ công -> đặt mức dâng (W = minTerrain + meters). Không re-render map.
  const handleManualLevel = (meters: number) => {
    if (storming) return;
    controller.setRise(meters);
  };

  // Kịch bản bão: luồng cảm biến giả lập ramp MỨC DÂNG TOÀN CỤC; mỗi đợt 1s suy ra độ sâu từng
  // hố ga (trạm trũng ngập sâu hơn) để dựng log IoT thực tế.
  const handleToggleStorm = () => {
    if (stormRef.current) {
      stormRef.current.stop();
      stormRef.current = null;
      setStorming(false);
      return;
    }
    stormRef.current = createStormStream({
      maxRise: waterRange,
      onRise: (rise) => {
        controller.setRise(rise);
        const rank: Record<string, number> = { danger: 0, warning: 1, normal: 2 };
        const sample: SensorLog[] = controller.stations
          .map((st, i) => {
            const depth = controller.sensorDepth(i);
            return { seq: 0, sensorId: st.id, level: depth, status: statusFromLevel(depth) };
          })
          .sort((a, b) => rank[a.status] - rank[b.status] || b.level - a.level)
          .slice(0, LOG_ROWS)
          .map((row) => ({ ...row, seq: logSeqRef.current++ }));
        setLogs(sample);
      },
    });
    setStorming(true);
  };

  return (
    <div style={{ display: "flex", width: "100vw", height: "100vh", overflow: "hidden" }}>
      <ControlPanelCesium
        initialLevel={controller.manualLevel}
        onManualLevel={handleManualLevel}
        onToggleStorm={handleToggleStorm}
        storming={storming}
        isReady={isReady}
        logs={logs}
        riseLevel={riseLevel}
        waterRange={waterRange}
        dangerStations={dangerStations}
        warningStations={warningStations}
        totalStations={controller.stations.length}
        terrainStatus={terrainStatus}
        ionAvailable={ION_TOKEN !== null}
        buildingKept={buildingCount.kept}
        buildingTotal={buildingCount.total}
        buildingInfo={buildingInfo}
        onCloseBuildingInfo={() => setBuildingInfo(null)}
        waterEffect={waterEffect}
        onWaterEffect={setWaterEffect}
        basemap={basemap}
        onBasemap={setBasemap}
        measureMode={measureMode}
        onMeasureMode={setMeasureMode}
        measureResult={measureResult}
      />
      <div style={{ flex: 1, position: "relative" }}>
        <MapContainerCesium
          controller={controller}
          ionToken={ION_TOKEN}
          waterEffect={waterEffect}
          basemap={basemap}
          measureMode={measureMode}
          onMeasure={setMeasureResult}
          onBuildingClick={setBuildingInfo}
          onTerrainStatus={setTerrainStatus}
          onWaterRange={setWaterRange}
          onBuildingCount={(kept, total) => setBuildingCount({ kept, total })}
          onReady={() => setIsReady(true)}
        />
        {!isReady && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: "rgba(8,15,30,0.7)",
              color: "#e2e8f0",
              fontFamily: "sans-serif",
              fontSize: "1rem",
              pointerEvents: "none",
              zIndex: 5,
            }}
          >
            🌍 Đang dựng địa hình + bản sao số đô thị…
          </div>
        )}
      </div>
    </div>
  );
};
