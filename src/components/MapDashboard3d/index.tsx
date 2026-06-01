import React, { useState, useEffect, useRef } from "react";
import { ControlPanel3d } from "./ControlPanel3d";
import { MapContainer3d } from "./MapContainer3d";
import type { BuildingFeatureCollection } from "../../utils/geoHelpers3d";

export const MapDashboard3d: React.FC = () => {
  const [buildingGeoJson, setBuildingGeoJson] = useState<BuildingFeatureCollection | null>(null);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [parseTime, setParseTime] = useState<number>(0);
  const [renderedCount, setRenderedCount] = useState<number>(0); // số toà nhà trong viewport
  const [totalCount, setTotalCount] = useState<number>(0); // tổng toà nhà trong bộ nhớ worker

  const workerRef = useRef<Worker | null>(null);
  const currentBboxRef = useRef<[number, number, number, number] | null>(null);

  useEffect(() => {
    // Khởi tạo Web Worker xử lý data 3D tách biệt
    workerRef.current = new Worker(new URL("../../workers/dataParser3d.worker.ts", import.meta.url), { type: "module" });

    workerRef.current.onmessage = (event: MessageEvent) => {
      const { type, payload, parseMs, total } = event.data;

      if (type === "GENERATE_DONE") {
        // Sinh + parse xong (việc nặng đã chạy trong worker): cập nhật metric, mở khoá UI
        setTotalCount(total);
        setParseTime(parseMs); // thời gian parse THẬT đo trong worker
        setIsProcessing(false);
      } else if (type === "VISIBLE_DATA") {
        // Chỉ nhận phần toà nhà trong viewport
        setBuildingGeoJson(payload);
        setRenderedCount(payload.features.length);
      }
    };

    return () => {
      if (workerRef.current) workerRef.current.terminate();
    };
  }, []);

  const handleLoadData = (count: number) => {
    setIsProcessing(true);
    // Toàn bộ việc nặng (generate + parse) đẩy sang worker -> main thread rảnh hoàn toàn, UI mượt
    workerRef.current?.postMessage({ type: "GENERATE_AND_PARSE", count });
  };

  // Bản đồ đứng yên -> gửi bbox cho worker lọc toà nhà trong viewport
  const handleMapMove = (bbox: [number, number, number, number]) => {
    currentBboxRef.current = bbox;
    workerRef.current?.postMessage({ type: "UPDATE_BBOX", bbox });
  };

  return (
    <div style={{ display: "flex", width: "100vw", height: "100vh", overflow: "hidden" }}>
      <ControlPanel3d
        onLoadData={handleLoadData}
        isProcessing={isProcessing}
        parseTime={parseTime}
        renderedBuildings={renderedCount}
        totalBuildings={totalCount}
      />
      <MapContainer3d buildingGeoJson={buildingGeoJson} isLoading={isProcessing} onMapMove={handleMapMove} />
    </div>
  );
};
