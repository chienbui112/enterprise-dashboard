import React, { useState, useEffect, useRef } from "react";
import { ControlPanel } from "./ControlPanel";
import { MapContainer } from "./MapContainer";
import { STATUSES, type DriverFeature } from "../../utils/geoHelpers";

export const MapDashboard: React.FC = () => {
  const TOTAL_DRIVERS = 100000;

  const [visibleDrivers, setVisibleDrivers] = useState<DriverFeature[]>([]);
  const [isBboxFilterActive, setIsBboxFilterActive] = useState<boolean>(true);
  const [isStreamingActive, setIsStreamingActive] = useState<boolean>(false);
  const [apiCallsCount, setApiCallsCount] = useState<number>(0);
  const [hasFirstData, setHasFirstData] = useState<boolean>(false); // đã nhận lô data đầu tiên chưa

  // Trạng thái khóa tương tác
  const [isInteracting, setIsInteracting] = useState<boolean>(false);

  // Lưu trạng thái vào Ref để khối hàm lắng nghe Worker (onmessage) luôn đọc được giá trị mới nhất mà không bị đóng băng
  const isInteractingRef = useRef(isInteracting);
  const workerRef = useRef<Worker | null>(null);
  const currentBboxRef = useRef<[number, number, number, number] | null>(null);
  // Object pool tái sử dụng: dựng GeoJSON 1 lần rồi mutate tại chỗ mỗi tick -> gần như 0 cấp phát
  const featurePoolRef = useRef<DriverFeature[]>([]);
  // Tọa độ điểm đến (tĩnh) theo driver index, nhận 1 lần từ worker; dùng khi click để tính ETA
  const [destinations, setDestinations] = useState<Float32Array | null>(null);

  useEffect(() => {
    isInteractingRef.current = isInteracting;
    // Báo worker tạm dừng/khôi phục filter + stream khi user pan/zoom để tiết kiệm CPU
    workerRef.current?.postMessage({
      type: "SET_INTERACTING",
      payload: { isActive: isInteracting },
    });
  }, [isInteracting]);

  // 1. Khởi tạo Web Worker và bắt sự kiện trả data về
  useEffect(() => {
    workerRef.current = new Worker(new URL("../../workers/dataParser.worker.ts", import.meta.url), { type: "module" });

    workerRef.current.onmessage = (event: MessageEvent) => {
      const { type } = event.data;

      // Điểm đến tĩnh, nhận 1 lần lúc khởi tạo
      if (type === "INIT_DESTINATIONS") {
        setDestinations(event.data.destCoords as Float32Array);
        return;
      }

      if (type !== "DATA_UPDATED") return;

      // CHỐNG LAG CỐT LÕI: nếu user đang pan/zoom thì bỏ qua (worker cũng đã pause, đây là lớp phòng vệ)
      if (isInteractingRef.current) return;

      const { count, coords, bearing, status, idx } = event.data as {
        count: number;
        coords: Float32Array;
        bearing: Float32Array;
        status: Uint8Array;
        idx: Uint32Array;
      };

      // Tái dựng GeoJSON từ typed array vào pool: mutate object có sẵn, không tạo object mới mỗi tick
      const pool = featurePoolRef.current;
      for (let i = 0; i < count; i++) {
        let f = pool[i];
        if (!f) {
          f = pool[i] = {
            type: "Feature",
            geometry: { type: "Point", coordinates: [0, 0] },
            properties: { idx: 0, status: "active", bearing: 0 },
          };
        }
        f.geometry.coordinates[0] = coords[i * 2];
        f.geometry.coordinates[1] = coords[i * 2 + 1];
        f.properties.idx = idx[i];
        f.properties.status = STATUSES[status[i]];
        f.properties.bearing = bearing[i];
      }

      // slice tạo ref mảng mới (để React/MapLibre nhận biết dữ liệu đổi) nhưng tái dùng object bên trong
      setVisibleDrivers(pool.slice(0, count));
      setApiCallsCount((prev) => prev + 1);
      setHasFirstData(true); // bỏ overlay loading sau lô data đầu tiên
    };

    workerRef.current.postMessage({
      type: "INIT_DATA",
      payload: {
        count: TOTAL_DRIVERS,
        bbox: currentBboxRef.current,
        isBboxFilterActive: isBboxFilterActive,
      },
    });

    return () => {
      if (workerRef.current) workerRef.current.terminate();
    };
  }, []);

  // 2. Đồng bộ Toggle Filter
  useEffect(() => {
    if (workerRef.current) {
      workerRef.current.postMessage({
        type: "TOGGLE_FILTER",
        payload: { isActive: isBboxFilterActive },
      });
    }
  }, [isBboxFilterActive]);

  // 3. Đồng bộ Trạng thái Live Stream
  useEffect(() => {
    if (workerRef.current) {
      workerRef.current.postMessage({
        type: "SET_STREAMING",
        payload: { isActive: isStreamingActive },
      });
    }
  }, [isStreamingActive]);

  // 4. Khi bản đồ đứng yên hẳn, gửi tọa độ Bbox sang cho Worker tính toán
  const handleMapMove = (bbox: [number, number, number, number]) => {
    currentBboxRef.current = bbox;
    if (workerRef.current) {
      workerRef.current.postMessage({
        type: "UPDATE_BBOX",
        payload: { bbox },
      });
    }
  };

  return (
    <div style={{ display: "flex", width: "100vw", height: "100vh", overflow: "hidden" }}>
      <ControlPanel
        isBboxFilterActive={isBboxFilterActive}
        setIsBboxFilterActive={setIsBboxFilterActive}
        isStreamingActive={isStreamingActive}
        setIsStreamingActive={setIsStreamingActive}
        totalDriversCount={TOTAL_DRIVERS}
        visibleDriversCount={visibleDrivers.length}
        apiCallsCount={apiCallsCount}
      />
      <MapContainer
        isBboxFilterActive={isBboxFilterActive}
        driversData={visibleDrivers}
        destinations={destinations}
        isLoading={!hasFirstData}
        onMapMove={handleMapMove}
        setIsInteracting={setIsInteracting} // Đăng ký hàm điều phối khóa tương tác
      />
    </div>
  );
};
