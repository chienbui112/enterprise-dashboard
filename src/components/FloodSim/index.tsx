import React, { useEffect, useRef, useState } from "react";
import { ControlPanelFlood } from "./ControlPanelFlood";
import {
  MapContainerFlood,
  type FloodScene,
  type SceneSource,
  type TilesStatus,
  type BasemapId,
} from "./MapContainerFlood";
import type { WaterRef } from "../../utils/floodLayers";

const BUILDING_COUNT = 3000;
const TREE_COUNT = 4000;
const BARRIER_COUNT = 600;

export const FloodSimDashboard: React.FC = () => {
  const [scene, setScene] = useState<FloodScene | null>(null);
  const [isProcessing, setIsProcessing] = useState(true);
  const [genMs, setGenMs] = useState(0);

  // Nguồn cảnh 3D + DEM (Phase B/C). Mặc định synthetic + DEM bật (luôn chạy được, không cần mạng).
  const [sceneSource, setSceneSource] = useState<SceneSource>("synthetic");
  const [terrainOn, setTerrainOn] = useState(true);
  const [terrainExaggeration, setTerrainExaggeration] = useState(1.5);
  const [tilesStatus, setTilesStatus] = useState<TilesStatus>("idle");
  const [basemap, setBasemap] = useState<BasemapId>("dark");

  const workerRef = useRef<Worker | null>(null);

  // Nguồn sự thật mực nước: 1 đối tượng mutable dùng chung Slider <-> custom WebGL layer.
  // Nằm NGOÀI React state nên đổi giá trị không gây re-render.
  const waterRef = useRef<WaterRef>({ meters: 0 });

  const generate = () => {
    setIsProcessing(true);
    workerRef.current?.postMessage({
      type: "GENERATE",
      buildingCount: BUILDING_COUNT,
      treeCount: TREE_COUNT,
      barrierCount: BARRIER_COUNT,
    });
  };

  useEffect(() => {
    workerRef.current = new Worker(new URL("../../workers/floodSim.worker.ts", import.meta.url), {
      type: "module",
    });

    workerRef.current.onmessage = (event: MessageEvent) => {
      const { type, buildings, trees, barriers, genMs: ms } = event.data;
      if (type === "SCENE_READY") {
        setScene({ buildings, trees, barriers });
        setGenMs(ms);
        setIsProcessing(false);
      }
    };

    // Sinh cảnh ngay khi vào dashboard.
    generate();

    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  // Mutate TẠI CHỖ thuộc tính của ref.current (escape hatch hợp lệ của React) để giữ nguyên
  // định danh đối tượng — custom WebGL layer đã giữ tham chiếu này từ lúc khởi tạo.
  const handleSetLevel = (meters: number) => {
    waterRef.current.meters = meters;
  };

  return (
    <div style={{ display: "flex", width: "100vw", height: "100vh", overflow: "hidden" }}>
      <ControlPanelFlood
        initialLevel={waterRef.current.meters}
        onSetLevel={handleSetLevel}
        isProcessing={isProcessing}
        genMs={genMs}
        buildingCount={scene ? scene.buildings.features.length : 0}
        treeCount={scene ? scene.trees.length / 4 : 0}
        barrierCount={scene ? scene.barriers.length / 4 : 0}
        onRegenerate={generate}
        sceneSource={sceneSource}
        onSceneSource={setSceneSource}
        terrainOn={terrainOn}
        onTerrainOn={setTerrainOn}
        terrainExaggeration={terrainExaggeration}
        onTerrainExaggeration={setTerrainExaggeration}
        tilesStatus={tilesStatus}
        basemap={basemap}
        onBasemap={setBasemap}
      />
      <MapContainerFlood
        scene={scene}
        isLoading={isProcessing}
        water={waterRef.current}
        sceneSource={sceneSource}
        terrainOn={terrainOn}
        terrainExaggeration={terrainExaggeration}
        basemap={basemap}
        onTilesStatus={setTilesStatus}
      />
    </div>
  );
};
