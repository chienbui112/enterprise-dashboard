import React, { useEffect, useRef, useState } from "react";
import { ControlPanelTsp, type SolveStatus, type RoutingSource, type TspResult } from "./ControlPanelTsp";
import { MapContainerTsp, type DrawLeg } from "./MapContainerTsp";
import { generateDeliveryPoints, buildSyntheticLegs, type DeliveryPoint, type RouteLeg } from "../../utils/routeApiHelper";
import { fetchOsrmTable, fetchOsrmRoute, haversineMatrix, assignMode } from "../../utils/osrmHelper";
import { AVG_SPEED_KMH } from "../../utils/geoHelpers";

const POINT_COUNT = 20;

// Cộng dồn chi phí dọc chu trình ĐÓNG theo thứ tự `order` (mtx tính bằng mét/giây).
const sumClosed = (order: number[], mtx: number[][]): number => {
  let s = 0;
  for (let i = 0; i < order.length - 1; i++) s += mtx[order[i]][order[i + 1]];
  s += mtx[order[order.length - 1]][order[0]]; // chặng quay về kho
  return s;
};

export const RouteOptimizerDashboard: React.FC = () => {
  // === React state: kết quả cuối cùng + cờ trạng thái nút + cờ bật overlay so sánh ===
  const [result, setResult] = useState<TspResult | null>(null);
  const [status, setStatus] = useState<SolveStatus>("idle");
  const [showCompare, setShowCompare] = useState<boolean>(false);

  // === useRef: toàn bộ dữ liệu/tính toán hình học (không trigger render) ===
  const pointsRef = useRef<DeliveryPoint[]>([]); // 20 toạ độ gốc
  const matrixRef = useRef<{ distances: number[][]; durations: number[][] | null } | null>(null);
  const legsRef = useRef<RouteLeg[]>([]); // hình học per-leg mới nhất
  const compareCoordsRef = useRef<[number, number][] | null>(null); // lộ trình NN (đường thẳng) để so sánh
  const sourceRef = useRef<RoutingSource>("OSRM"); // OSRM hay fallback (set lại mỗi lần giải)
  const workerRef = useRef<Worker | null>(null);

  // Cầu nối imperative tới map (gán bởi MapContainerTsp ở effect mount của nó — chạy TRƯỚC effect này).
  const renderPointsRef = useRef<((pts: DeliveryPoint[]) => void) | null>(null);
  const drawRouteRef = useRef<((legs: DrawLeg[], order: number[]) => void) | null>(null);
  const clearRouteRef = useRef<(() => void) | null>(null);
  const drawCompareRef = useRef<((coords: [number, number][] | null) => void) | null>(null);

  // Sinh điểm mới vào ref + đẩy xuống map vẽ. KHÔNG đụng React state -> dùng được cả lúc init.
  const buildAndRenderPoints = () => {
    const pts = generateDeliveryPoints(POINT_COUNT);
    pointsRef.current = pts;
    matrixRef.current = null;
    legsRef.current = [];
    compareCoordsRef.current = null;
    renderPointsRef.current?.(pts);
  };

  // Nút "Tạo điểm mới": sinh điểm + reset kết quả cũ trên UI.
  const regenerate = () => {
    buildAndRenderPoints();
    setResult(null);
    setStatus("idle");
  };

  // Worker init: 1 lần ở mount, terminate ở unmount.
  useEffect(() => {
    const w = new Worker(new URL("../../workers/tspSolver.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = w;

    // Worker trả thứ tự tối ưu -> lấy hình học đường thật (OSRM /route) -> vẽ 2 layer.
    w.onmessage = async (e: MessageEvent) => {
      if (e.data?.type !== "SOLVED") return;
      const { order, nnOrder, nnCost, twoOptCost, exactCost, optimal } = e.data as {
        order: number[];
        nnOrder: number[];
        nnCost: number;
        twoOptCost: number;
        exactCost: number | null;
        optimal: boolean;
      };
      const pts = pointsRef.current;
      const mtx = matrixRef.current;
      if (!mtx) return;

      // Lộ trình NN dạng đường THẲNG nối điểm (+ đóng vòng) -> lưu ref để bật/tắt overlay so sánh.
      const nnCoords: [number, number][] = nnOrder.map((i) => [pts[i].lng, pts[i].lat]);
      nnCoords.push([pts[nnOrder[0]].lng, pts[nnOrder[0]].lat]);
      compareCoordsRef.current = nnCoords; // effect [showCompare, result] sẽ vẽ sau khi setResult commit

      // Toạ độ theo thứ tự tối ưu + đóng vòng về kho.
      const orderedCoords: [number, number][] = order.map((i) => [pts[i].lng, pts[i].lat]);
      orderedCoords.push([pts[order[0]].lng, pts[order[0]].lat]);

      // Hình học chi tiết: ưu tiên OSRM /route (đường thật); lỗi -> polyline giả lập.
      setStatus("routing");
      let legs: RouteLeg[];
      try {
        legs = await fetchOsrmRoute(orderedCoords);
      } catch {
        legs = buildSyntheticLegs(orderedCoords);
        sourceRef.current = "fallback";
      }
      legsRef.current = legs;

      // Gán phương thức cho từng chặng rồi vẽ (hình học -> ref, không vào state).
      const drawLegs: DrawLeg[] = legs.map((leg) => ({ coords: leg.coords, mode: assignMode(leg.distanceM) }));
      drawRouteRef.current?.(drawLegs, order);

      // Tổng quãng đường (theo ma trận đã tối ưu) + thời gian (ma trận duration nếu có).
      const distanceKm = sumClosed(order, mtx.distances) / 1000;
      const durationMin = mtx.durations
        ? sumClosed(order, mtx.durations) / 60
        : (distanceKm / AVG_SPEED_KMH) * 60; // fallback: ước tính từ tốc độ trung bình

      // Chỉ kết quả cuối cùng mới lên React state.
      setResult({
        ordered: order.map((idx, rank) => ({ ...pts[idx], rank })),
        distanceKm,
        durationMin,
        nnKm: nnCost,
        twoOptKm: twoOptCost,
        exactKm: exactCost,
        optimal,
        routingSource: sourceRef.current,
      });
      setStatus("done");
    };

    // Sinh điểm khởi tạo (effect con của MapContainer đã gán renderPointsRef trước effect này).
    buildAndRenderPoints();

    return () => w.terminate();
  }, []);

  // Vẽ/ẩn overlay so sánh: chạy khi toggle thay đổi HOẶC khi có kết quả giải mới (result đổi
  // -> compareCoordsRef đã được set trong handler trước setResult). Chỉ tác động map.
  useEffect(() => {
    drawCompareRef.current?.(showCompare ? compareCoordsRef.current : null);
  }, [showCompare, result]);

  const handleOptimize = async () => {
    if (status !== "idle" && status !== "done") return;
    if (pointsRef.current.length < 2) return;
    clearRouteRef.current?.();
    setResult(null);
    sourceRef.current = "OSRM";

    // Tầng 1: ma trận khoảng cách THẬT từ OSRM /table; lỗi -> haversine (fallback).
    setStatus("matrix");
    const pts = pointsRef.current;
    try {
      matrixRef.current = await fetchOsrmTable(pts);
    } catch {
      matrixRef.current = { distances: haversineMatrix(pts), durations: null };
      sourceRef.current = "fallback";
    }

    // Tầng 2: đẩy ma trận xuống Worker giải TSP (không block UI).
    setStatus("solving");
    workerRef.current?.postMessage({
      type: "SOLVE_TSP",
      payload: { matrix: matrixRef.current.distances, n: pts.length, startIndex: 0 },
    });
  };

  const isLoading = status !== "idle" && status !== "done";
  const loadingLabel =
    status === "matrix" ? "Đang lấy ma trận khoảng cách (OSRM)..." : status === "routing" ? "Đang lấy đường đi thật (OSRM)..." : "Đang giải TSP trong Worker...";

  return (
    <div style={{ display: "flex", width: "100vw", height: "100vh", overflow: "hidden" }}>
      <ControlPanelTsp
        status={status}
        result={result}
        pointCount={POINT_COUNT}
        showCompare={showCompare}
        setShowCompare={setShowCompare}
        onOptimize={handleOptimize}
        onRegenerate={regenerate}
      />
      <MapContainerTsp
        isLoading={isLoading}
        loadingLabel={loadingLabel}
        renderPointsRef={renderPointsRef}
        drawRouteRef={drawRouteRef}
        clearRouteRef={clearRouteRef}
        drawCompareRef={drawCompareRef}
      />
    </div>
  );
};
