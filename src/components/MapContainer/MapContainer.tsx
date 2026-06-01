import React, { useEffect, useRef } from "react";
import maplibre, { Map, NavigationControl, GeoJSONSource, Popup, type MapGeoJSONFeature, type MapMouseEvent } from "maplibre-gl";
import { type DriverFeature, type DriverStatus, AVG_SPEED_KMH, haversineKm, driverName } from "../../utils/geoHelpers";
import { MapLoadingOverlay } from "../MapLoadingOverlay";
import "maplibre-gl/dist/maplibre-gl.css";

interface MapContainerProps {
  isBboxFilterActive: boolean;
  driversData: DriverFeature[];
  destinations: Float32Array | null; // [lng, lat] theo driver index, dùng để tính ETA khi click
  isLoading: boolean; // Đang xử lý mà chưa có dữ liệu hiển thị
  onMapMove: (bbox: [number, number, number, number]) => void;
  setIsInteracting: (interacting: boolean) => void; // Callback mới để báo trạng thái kéo/zoom
}

const STATUS_LABEL: Record<DriverStatus, string> = {
  active: "Đang giao",
  busy: "Bận",
  offline: "Ngoại tuyến",
};
const STATUS_COLOR: Record<DriverStatus, string> = {
  active: "#4ade80",
  busy: "#f59e0b",
  offline: "#94a3b8",
};

// Tạo icon mũi tên (SDF) bằng canvas: tô màu được qua icon-color, xoay được qua icon-rotate
const createArrowImage = (): ImageData => {
  const size = 24;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.moveTo(size / 2, 2); // đỉnh (hướng Bắc khi bearing = 0)
  ctx.lineTo(size - 4, size - 3);
  ctx.lineTo(size / 2, size * 0.68);
  ctx.lineTo(4, size - 3);
  ctx.closePath();
  ctx.fill();
  return ctx.getImageData(0, 0, size, size);
};

const buildPopupHTML = (idx: number, status: DriverStatus, cur: [number, number], dest: [number, number]): string => {
  const distanceKm = haversineKm(cur[0], cur[1], dest[0], dest[1]);
  const etaMin = (distanceKm / AVG_SPEED_KMH) * 60;
  const arrival = new Date(Date.now() + etaMin * 60_000).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
  const fmt = (c: [number, number]) => `${c[1].toFixed(5)}, ${c[0].toFixed(5)}`;

  return `
    <div style="font-family: sans-serif; min-width: 220px;">
      <div style="font-weight: 700; font-size: 14px; margin-bottom: 6px;">${driverName(idx)}</div>
      <div style="display:inline-block; padding:2px 8px; border-radius:10px; font-size:11px; color:#0f172a; background:${STATUS_COLOR[status]}; margin-bottom:8px;">
        ${STATUS_LABEL[status]}
      </div>
      <table style="font-size:12px; color:#334155; width:100%; border-collapse:collapse;">
        <tr><td style="color:#64748b; padding:2px 0;">Vị trí</td><td style="text-align:right;">${fmt(cur)}</td></tr>
        <tr><td style="color:#64748b; padding:2px 0;">Điểm đến</td><td style="text-align:right;">${fmt(dest)}</td></tr>
        <tr><td style="color:#64748b; padding:2px 0;">Khoảng cách</td><td style="text-align:right;">${distanceKm.toFixed(2)} km</td></tr>
        <tr><td style="color:#64748b; padding:2px 0;">ETA</td><td style="text-align:right; font-weight:700;">${Math.ceil(etaMin)} phút</td></tr>
        <tr><td style="color:#64748b; padding:2px 0;">Dự kiến giao</td><td style="text-align:right; font-weight:700; color:#0ea5e9;">${arrival}</td></tr>
      </table>
    </div>`;
};

const EMPTY_FC: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

export const MapContainer: React.FC<MapContainerProps> = ({ isBboxFilterActive, driversData, destinations, isLoading, onMapMove, setIsInteracting }) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const popupRef = useRef<Popup | null>(null);
  // idx tài xế đang được chọn (mở popup); null = không chọn ai
  const selectedIdxRef = useRef<number | null>(null);

  // Lưu filter state vào ref để tránh các sự kiện lắng nghe của Map bị dính closure (lỗi bộ nhớ đệm giá trị cũ)
  const isBboxFilterActiveRef = useRef(isBboxFilterActive);

  // onMapMove/destinations đổi qua mỗi render; listener của Map chỉ đăng ký 1 lần (useEffect[]) nên
  // phải đọc qua ref để luôn dùng bản mới nhất, tránh dính closure giá trị cũ.
  const onMapMoveRef = useRef(onMapMove);
  onMapMoveRef.current = onMapMove;
  const destinationsRef = useRef(destinations);
  destinationsRef.current = destinations;

  useEffect(() => {
    isBboxFilterActiveRef.current = isBboxFilterActive;
    // Nếu tắt Bbox filter, trigger một lần để fetch/hiển thị lại toàn bộ 100,000 điểm
    if (!isBboxFilterActive && mapRef.current) {
      triggerBboxUpdate();
    }
  }, [isBboxFilterActive]);

  // CHỐNG NGHẼN: Chỉ nạp dữ liệu vào MapSource khi nhận được data mới từ luồng thảnh thơi bên ngoài
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const source = map.getSource("drivers-source") as GeoJSONSource;
    if (source) {
      source.setData({
        type: "FeatureCollection",
        features: driversData,
      });
    }
    // Đồng bộ popup + đường nối của tài xế đang chọn theo vị trí mới nhất
    refreshSelection(map, driversData);
  }, [driversData]);

  const triggerBboxUpdate = () => {
    if (!mapRef.current) return;
    const bounds = mapRef.current.getBounds();
    const west = bounds.getWest();
    const south = bounds.getSouth();
    const east = bounds.getEast();
    const north = bounds.getNorth();

    // Nới bbox thêm 20% mỗi chiều để prefetch điểm sát rìa -> pan nhẹ không bị "pop-in"
    const padX = (east - west) * 0.2;
    const padY = (north - south) * 0.2;
    onMapMoveRef.current([west - padX, south - padY, east + padX, north + padY]);
  };

  // Vẽ đường nối tài xế -> điểm đến (kèm điểm đích) vào layer phụ trợ
  const drawSelectionLine = (map: Map, cur: [number, number], dest: [number, number]) => {
    (map.getSource("selection") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: { type: "LineString", coordinates: [cur, dest] }, properties: {} },
        { type: "Feature", geometry: { type: "Point", coordinates: dest }, properties: {} },
      ],
    });
  };

  // Hiển thị popup thông tin + đường tới đích + ETA khi click vào một tài xế
  const showDriverPopup = (map: Map, feature: MapGeoJSONFeature) => {
    const dests = destinationsRef.current;
    if (!dests) return;

    const idx = feature.properties.idx as number;
    const status = feature.properties.status as DriverStatus;
    const cur = (feature.geometry as GeoJSON.Point).coordinates as [number, number];
    const dest: [number, number] = [dests[idx * 2], dests[idx * 2 + 1]];

    // Đóng popup cũ TRƯỚC: remove() kích hoạt sự kiện "close" (xóa selection), nên phải làm
    // trước khi vẽ đường nối mới, tránh tự xóa ngay thứ vừa set.
    popupRef.current?.remove();
    selectedIdxRef.current = idx;
    drawSelectionLine(map, cur, dest);

    // closeOnClick: false -> tránh chính cú click mở popup làm đóng ngay (khiến đường nối "lóe lên rồi biến mất")
    popupRef.current = new maplibre.Popup({ closeButton: true, closeOnClick: false, maxWidth: "280px" })
      .setLngLat(cur)
      .setHTML(buildPopupHTML(idx, status, cur, dest))
      .addTo(map);

    // Bỏ chọn + xóa đường nối khi đóng popup
    popupRef.current.on("close", () => {
      selectedIdxRef.current = null;
      (map.getSource("selection") as GeoJSONSource)?.setData(EMPTY_FC);
    });
  };

  // Cập nhật popup + đường nối theo dữ liệu mới (real-time tick hoặc đổi filter).
  // Nếu tài xế đang chọn không còn trong tập hiển thị -> đóng popup.
  const refreshSelection = (map: Map, features: DriverFeature[]) => {
    const idx = selectedIdxRef.current;
    const dests = destinationsRef.current;
    if (idx == null || !popupRef.current || !dests) return;

    const feature = features.find((f) => f.properties.idx === idx);
    if (!feature) {
      popupRef.current.remove(); // -> trigger "close": reset selection + xóa đường nối
      return;
    }

    const cur = feature.geometry.coordinates;
    const dest: [number, number] = [dests[idx * 2], dests[idx * 2 + 1]];
    drawSelectionLine(map, cur, dest);
    popupRef.current.setLngLat(cur).setHTML(buildPopupHTML(idx, feature.properties.status, cur, dest));
  };

  useEffect(() => {
    if (!mapContainerRef.current) return;

    // 1. Khởi tạo bản đồ
    const map = new maplibre.Map({
      container: mapContainerRef.current,
      style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json", // Dùng dark-mode cho chuyên nghiệp
      center: [105.8342, 21.0278],
      zoom: 12,
      trackResize: true,
    });

    map.addControl(new NavigationControl(), "top-right");
    mapRef.current = map;

    // --- CÁC SỰ KIỆN TỐI ƯU HÓA TƯƠNG TÁC (INTERACTION EVENTS) ---

    // Khi bắt đầu kéo hoặc zoom -> Khóa luồng dữ liệu ngay lập tức để giải phóng CPU/GPU cho hiệu ứng mượt mà
    const handleMoveStart = () => {
      setIsInteracting(true);
    };

    // Khi dừng di chuyển/zoom hẳn -> Mở khóa và yêu cầu Worker tính toán nạp dữ liệu một lần duy nhất
    const handleMoveEnd = () => {
      setIsInteracting(false);
      triggerBboxUpdate();
    };

    map.on("movestart", handleMoveStart);
    map.on("zoomstart", handleMoveStart);
    map.on("moveend", handleMoveEnd);

    map.on("load", () => {
      // Icon mũi tên (SDF) cho hướng di chuyển
      map.addImage("driver-arrow", createArrowImage(), { sdf: true });

      // TỐI ƯU: clusterMaxZoom 14 để vẫn gom cụm ở mức zoom thấp/trung (tránh đổ hàng chục nghìn điểm rời
      // ngay tại zoom khởi tạo 12); radius 60 để giảm số cụm phải vẽ.
      map.addSource("drivers-source", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        cluster: true,
        clusterMaxZoom: 14,
        clusterRadius: 60,
      });

      // Source phụ trợ: đường nối + điểm đích khi chọn 1 tài xế
      map.addSource("selection", { type: "geojson", data: EMPTY_FC });

      // Layer Clusters
      map.addLayer({
        id: "clusters",
        type: "circle",
        source: "drivers-source",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": ["step", ["get", "point_count"], "#38bdf8", 500, "#f59e0b", 2000, "#ef4444"],
          "circle-radius": ["step", ["get", "point_count"], 18, 500, 25, 2000, 32],
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#fff",
        },
      });

      // Layer Cluster Count
      map.addLayer({
        id: "cluster-count",
        type: "symbol",
        source: "drivers-source",
        filter: ["has", "point_count"],
        layout: {
          "text-field": "{point_count}",
          "text-font": ["Noto Sans Regular"],
          "text-size": 11,
        },
        paint: { "text-color": "#fff" },
      });

      // Đường nối tới điểm đến (vẽ dưới các điểm tài xế)
      map.addLayer({
        id: "selection-line",
        type: "line",
        source: "selection",
        filter: ["==", ["geometry-type"], "LineString"],
        paint: { "line-color": "#0ea5e9", "line-width": 2, "line-dasharray": [2, 1] },
      });
      // Điểm đích
      map.addLayer({
        id: "selection-dest",
        type: "circle",
        source: "selection",
        filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-color": "#0ea5e9", "circle-radius": 7, "circle-stroke-width": 2, "circle-stroke-color": "#fff" },
      });

      // Layer Unclustered Points -> mũi tên xoay theo hướng di chuyển, tô màu theo trạng thái
      map.addLayer({
        id: "unclustered-point",
        type: "symbol",
        source: "drivers-source",
        filter: ["!", ["has", "point_count"]],
        layout: {
          "icon-image": "driver-arrow",
          "icon-size": 0.7,
          "icon-rotate": ["get", "bearing"],
          "icon-rotation-alignment": "map",
          "icon-allow-overlap": true,
        },
        paint: {
          "icon-color": ["match", ["get", "status"], "active", "#4ade80", "busy", "#f59e0b", "offline", "#94a3b8", "#fff"],
        },
      });

      // Click vào tài xế -> popup thông tin + ETA
      map.on("click", "unclustered-point", (e: MapMouseEvent & { features?: MapGeoJSONFeature[] }) => {
        if (e.features?.[0]) showDriverPopup(map, e.features[0]);
      });

      // Click vào cụm -> zoom vào để tách cụm
      map.on("click", "clusters", async (e: MapMouseEvent & { features?: MapGeoJSONFeature[] }) => {
        const feature = e.features?.[0];
        if (!feature) return;
        const clusterId = feature.properties.cluster_id as number;
        const source = map.getSource("drivers-source") as GeoJSONSource;
        const zoom = await source.getClusterExpansionZoom(clusterId);
        map.easeTo({ center: (feature.geometry as GeoJSON.Point).coordinates as [number, number], zoom });
      });

      // Con trỏ pointer khi rê qua đối tượng click được
      for (const layer of ["unclustered-point", "clusters"]) {
        map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
      }

      // Kích hoạt cập nhật Bbox lần đầu tiên
      triggerBboxUpdate();
    });

    // 6. CLEANUP LOGIC: Loại bỏ sự kiện lắng nghe và hủy hoàn toàn Map Instance khi cấu phần bị tháo dỡ
    return () => {
      if (mapRef.current) {
        console.log("Component unmounted: Safely removing map engine to prevent memory leaks.");
        popupRef.current?.remove();
        map.off("moveend", handleMoveEnd);
        map.off("movestart", handleMoveStart);
        map.off("zoomstart", handleMoveStart);
        map.remove();
        mapRef.current = null;
      }
    };
  }, []);

  return (
    <div style={{ flex: 1, position: "relative", height: "100vh" }}>
      <div ref={mapContainerRef} style={{ width: "100%", height: "100%" }} />
      <MapLoadingOverlay visible={isLoading} label="Đang tải 100.000 tài xế..." />
    </div>
  );
};
