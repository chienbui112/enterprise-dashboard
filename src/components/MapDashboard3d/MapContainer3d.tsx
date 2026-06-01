import React, { useEffect, useRef } from "react";
import maplibre, { Map, NavigationControl } from "maplibre-gl";
import type { BuildingFeatureCollection } from "../../utils/geoHelpers3d";
import { MapLoadingOverlay } from "../MapLoadingOverlay";
import "maplibre-gl/dist/maplibre-gl.css";

interface MapContainer3dProps {
  buildingGeoJson: BuildingFeatureCollection | null;
  isLoading: boolean;
  onMapMove: (bbox: [number, number, number, number]) => void;
}

export const MapContainer3d: React.FC<MapContainer3dProps> = ({ buildingGeoJson, isLoading, onMapMove }) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);

  // onMapMove tạo lại mỗi render; listener đăng ký 1 lần -> đọc qua ref để luôn dùng bản mới nhất
  const onMapMoveRef = useRef(onMapMove);
  onMapMoveRef.current = onMapMove;

  // Cập nhật dữ liệu 3D khi worker gửi về phần toà nhà trong viewport
  useEffect(() => {
    if (!mapRef.current || !buildingGeoJson) return;
    const source = mapRef.current.getSource("buildings-3d-source") as maplibre.GeoJSONSource;
    if (source) {
      source.setData(buildingGeoJson as GeoJSON.FeatureCollection);
    }
  }, [buildingGeoJson]);

  const triggerBboxUpdate = () => {
    if (!mapRef.current) return;
    const bounds = mapRef.current.getBounds();
    const west = bounds.getWest();
    const south = bounds.getSouth();
    const east = bounds.getEast();
    const north = bounds.getNorth();
    // Nới bbox 20% để prefetch toà nhà sát rìa, tránh "pop-in" khi pan
    const padX = (east - west) * 0.2;
    const padY = (north - south) * 0.2;
    onMapMoveRef.current([west - padX, south - padY, east + padX, north + padY]);
  };

  useEffect(() => {
    if (!mapContainerRef.current) return;

    const map = new maplibre.Map({
      container: mapContainerRef.current,
      style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
      center: [105.8, 21.0],
      zoom: 14,
      pitch: 55, // Nghiêng bản đồ 55 độ mặc định để thấy rõ khối 3D
      bearing: -20,
      trackResize: true,
    });

    map.addControl(new NavigationControl(), "top-right");
    mapRef.current = map;

    // Bản đồ đứng yên hẳn -> yêu cầu worker lọc lại toà nhà theo viewport mới
    const handleMoveEnd = () => triggerBboxUpdate();
    map.on("moveend", handleMoveEnd);

    map.on("load", () => {
      // Khởi tạo Source rỗng chứa dữ liệu không gian
      map.addSource("buildings-3d-source", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      // --- SỬ DỤNG LAYER FILL-EXTRUSION ĐỂ DỰNG KHỐI 3D ---
      map.addLayer({
        id: "buildings-3d-layer",
        type: "fill-extrusion",
        source: "buildings-3d-source",
        paint: {
          // Lấy màu sắc trực tiếp từ thuộc tính base_color của từng tòa nhà
          "fill-extrusion-color": ["get", "base_color"],
          // Lấy độ cao để đẩy khối 3D lên (Đơn vị tính: Mét)
          "fill-extrusion-height": ["get", "height"],
          // Độ cao cách mặt đất (mặc định bằng 0)
          "fill-extrusion-base": 0,
          // Tạo hiệu ứng đổ bóng mờ nhẹ để khối 3D trông chân thật hơn
          "fill-extrusion-opacity": 0.85,
        },
      });

      // Gửi bbox lần đầu để worker biết viewport hiện tại (data sẽ tới sau khi bấm Load)
      triggerBboxUpdate();
    });

    return () => {
      if (mapRef.current) {
        map.off("moveend", handleMoveEnd);
        map.remove();
        mapRef.current = null;
      }
    };
  }, []);

  return (
    <div style={{ flex: 1, position: "relative", height: "100vh" }}>
      <div ref={mapContainerRef} style={{ width: "100%", height: "100%" }} />
      <MapLoadingOverlay visible={isLoading} label="Đang sinh + parse toà nhà trong worker..." />
    </div>
  );
};
