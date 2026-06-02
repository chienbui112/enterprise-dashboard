import React, { useEffect, useRef } from "react";
import maplibre, { Map, NavigationControl } from "maplibre-gl";
import type { MapboxOverlay } from "@deck.gl/mapbox";
import { MapLoadingOverlay } from "../MapLoadingOverlay";
import { FloodWaterLayer, InstancedPropsLayer, type WaterRef } from "../../utils/floodLayers";
import { createGoogle3DTilesOverlay } from "../../utils/google3dTiles";
import { SCENE_CENTER, SCENE_HALF_DEG_WATER, type FloodBuildingCollection } from "../../utils/floodHelpers";
import "maplibre-gl/dist/maplibre-gl.css";

export interface FloodScene {
  buildings: FloodBuildingCollection;
  trees: Float32Array;
  barriers: Float32Array;
}

export type SceneSource = "synthetic" | "maptiler" | "google";
export type TilesStatus = "idle" | "loading" | "ready" | "error";
export type BasemapId = "dark" | "light" | "voyager";

// Các nền bản đồ Carto (miễn phí, cùng nhà với style hiện tại). positron/voyager là nền SÁNG.
export const BASEMAP_OPTIONS: { id: BasemapId; label: string }[] = [
  { id: "dark", label: "🌑 Tối" },
  { id: "light", label: "☀️ Sáng" },
  { id: "voyager", label: "🗺️ Voyager" },
];
const BASEMAPS: Record<BasemapId, string> = {
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  light: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  voyager: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json",
};

interface MapContainerFloodProps {
  scene: FloodScene | null;
  isLoading: boolean;
  // Đối tượng mực nước dùng chung với Slider — KHÔNG nằm trong React state.
  water: WaterRef;
  // Nguồn cảnh 3D: "synthetic" (nhà giả lập + DEM terrain) hay "google" (Photorealistic 3D Tiles).
  sceneSource: SceneSource;
  terrainOn: boolean; // DEM (chỉ áp dụng ở chế độ synthetic)
  terrainExaggeration: number;
  basemap: BasemapId;
  onTilesStatus?: (status: TilesStatus, message?: string) => void;
}

const BUILDINGS_SRC = "flood-buildings-src";
const BUILDINGS_LAYER = "flood-buildings-layer";
const PROPS_LAYER = "flood-props-layer";
const WATER_LAYER = "flood-water-layer";
const DEM_SRC = "flood-dem";
// DEM công khai (Mapzen/Terrarium trên AWS Open Data) — không cần API key.
const DEM_TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

// MapTiler OpenMapTiles vector tiles -> nhà 3D THẬT bằng fill-extrusion native (KHÔNG cần deck.gl).
// Key lấy từ VITE_MAPTILER_KEY (.env.local, KHÔNG commit). Lưu ý: key MapTiler thường giới hạn theo
// ORIGIN — phải thêm origin (localhost + domain) vào allowlist ở cloud.maptiler.com nếu bị 403.
const MAPTILER_KEY = (import.meta.env.VITE_MAPTILER_KEY as string | undefined) || "";
const MAPTILER_SRC = "maptiler-omt";
const MAPTILER_BUILDINGS = "maptiler-3d-buildings";
const MAPTILER_TILEJSON = `https://api.maptiler.com/tiles/v3-openmaptiles/tiles.json?key=${MAPTILER_KEY}`;

// Lớp building của OpenMapTiles dùng render_height/render_min_height (fallback height/min_height).
const addMaptilerBuildings = (map: Map, beforeId?: string): void => {
  if (!map.getSource(MAPTILER_SRC)) {
    map.addSource(MAPTILER_SRC, { type: "vector", url: MAPTILER_TILEJSON });
  }
  if (!map.getLayer(MAPTILER_BUILDINGS)) {
    map.addLayer(
      {
        id: MAPTILER_BUILDINGS,
        type: "fill-extrusion",
        source: MAPTILER_SRC,
        "source-layer": "building",
        minzoom: 12,
        // Bỏ qua các mảnh không nên dựng khối 3D (OpenMapTiles đánh dấu hide_3d=true).
        filter: ["!=", ["get", "hide_3d"], true],
        paint: {
          // Cao càng sáng -> phân biệt cao tầng/thấp tầng.
          "fill-extrusion-color": [
            "interpolate",
            ["linear"],
            ["coalesce", ["get", "render_height"], 0],
            0, "#9aa7b5",
            40, "#c4cfdb",
            120, "#eef2f6",
          ],
          "fill-extrusion-height": ["coalesce", ["get", "render_height"], ["get", "height"], 3],
          "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], ["get", "min_height"], 0],
          "fill-extrusion-opacity": 0.92,
        },
      },
      beforeId, // chèn TRƯỚC lớp nước -> nước (trong suốt) vẽ sau, blend đúng
    );
  }
};

const removeMaptilerBuildings = (map: Map): void => {
  if (map.getLayer(MAPTILER_BUILDINGS)) map.removeLayer(MAPTILER_BUILDINGS);
  if (map.getSource(MAPTILER_SRC)) map.removeSource(MAPTILER_SRC);
};

export const MapContainerFlood: React.FC<MapContainerFloodProps> = ({
  scene,
  isLoading,
  water,
  sceneSource,
  terrainOn,
  terrainExaggeration,
  basemap,
  onTilesStatus,
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const mapLoadedRef = useRef(false);
  const addedRef = useRef(false); // tránh add custom layer hai lần

  const propsLayerRef = useRef<InstancedPropsLayer | null>(null);
  const deckOverlayRef = useRef<MapboxOverlay | null>(null);

  // ref-for-prop: các hàm sync đọc prop mới nhất nhưng được gọi cả từ handler "load".
  const onTilesStatusRef = useRef(onTilesStatus);
  onTilesStatusRef.current = onTilesStatus;
  const applySceneRef = useRef<() => void>(() => {});
  const syncTerrainRef = useRef<() => void>(() => {});
  const syncTilesRef = useRef<() => void>(() => {});
  const setupAfterStyleRef = useRef<() => void>(() => {});
  const basemapRef = useRef(basemap);

  applySceneRef.current = () => {
    const map = mapRef.current;
    if (!map || !scene || !mapLoadedRef.current || addedRef.current) return;

    // 1. Đổ dữ liệu toà nhà vào source -> fill-extrusion dựng khối 3D.
    const src = map.getSource(BUILDINGS_SRC) as maplibre.GeoJSONSource | undefined;
    if (!src) return;
    src.setData(scene.buildings as unknown as GeoJSON.FeatureCollection);

    // 2. Thêm 2 custom WebGL layer SAU lớp toà nhà:
    //    - Props (cây/rào) vẽ trước, là vật đặc -> ghi depth.
    //    - Mặt nước trong suốt vẽ sau cùng -> blend đè lên mọi thứ thấp hơn mực nước.
    // Mặt nước phủ rộng (kín tầm nhìn ở mọi zoom đô thị) — tấm phẳng nên rất rẻ.
    const bbox: [number, number, number, number] = [
      SCENE_CENTER[0] - SCENE_HALF_DEG_WATER,
      SCENE_CENTER[1] - SCENE_HALF_DEG_WATER,
      SCENE_CENTER[0] + SCENE_HALF_DEG_WATER,
      SCENE_CENTER[1] + SCENE_HALF_DEG_WATER,
    ];

    const propsLayer = new InstancedPropsLayer({
      id: PROPS_LAYER,
      waterRef: water,
      trees: scene.trees,
      barriers: scene.barriers,
    });
    propsLayerRef.current = propsLayer;
    map.addLayer(propsLayer);
    map.addLayer(
      // segments: 1 -> tấm nước chỉ là 1 quad (2 tam giác). Phẳng + sóng bằng màu nên không
      // cần lưới dày; tránh hẳn pattern "ô nhỏ" do z-fighting lộ cạnh từng ô lưới.
      new FloodWaterLayer({ id: WATER_LAYER, waterRef: water, bbox, segments: 1, animate: true }),
    );

    addedRef.current = true;
    // Áp dụng ngay trạng thái nguồn cảnh hiện tại (ẩn/hiện props, terrain, tiles).
    syncTilesRef.current();
    syncTerrainRef.current();
  };

  // DEM terrain — áp dụng cho synthetic & maptiler; chế độ google dùng địa hình của 3D Tiles.
  syncTerrainRef.current = () => {
    const map = mapRef.current;
    if (!map || !mapLoadedRef.current) return;
    const wantTerrain = sceneSource !== "google" && terrainOn;
    if (wantTerrain) {
      if (!map.getSource(DEM_SRC)) {
        map.addSource(DEM_SRC, {
          type: "raster-dem",
          tiles: [DEM_TILES],
          encoding: "terrarium",
          tileSize: 256,
          maxzoom: 15,
        });
      }
      map.setTerrain({ source: DEM_SRC, exaggeration: terrainExaggeration });
    } else {
      map.setTerrain(null);
    }
  };

  // Nguồn cảnh: chuyển giữa synthetic (nhà giả lập) / maptiler (vector 3D thật) / google (3D Tiles).
  syncTilesRef.current = () => {
    const map = mapRef.current;
    if (!map || !mapLoadedRef.current) return;
    const src = sceneSource;
    const beforeWater = map.getLayer(WATER_LAYER) ? WATER_LAYER : undefined;

    // Nhà/cây giả lập chỉ hiện ở chế độ synthetic.
    if (map.getLayer(BUILDINGS_LAYER)) {
      map.setLayoutProperty(BUILDINGS_LAYER, "visibility", src === "synthetic" ? "visible" : "none");
    }
    propsLayerRef.current?.setVisible(src === "synthetic");

    // MapTiler vector 3D buildings (fill-extrusion native).
    if (src === "maptiler") addMaptilerBuildings(map, beforeWater);
    else removeMaptilerBuildings(map);

    if (src === "google") {
      map.setTerrain(null); // tiles đã có địa hình thật
      if (!deckOverlayRef.current) {
        onTilesStatusRef.current?.("loading");
        const overlay = createGoogle3DTilesOverlay({
          beforeId: beforeWater,
          onTilesetLoad: () => onTilesStatusRef.current?.("ready"),
          onError: (m) => onTilesStatusRef.current?.("error", m),
        });
        deckOverlayRef.current = overlay;
        map.addControl(overlay as unknown as maplibre.IControl);
      }
    } else {
      if (deckOverlayRef.current) {
        try {
          map.removeControl(deckOverlayRef.current as unknown as maplibre.IControl);
        } catch {
          /* noop */
        }
        deckOverlayRef.current = null;
      }
      onTilesStatusRef.current?.("idle");
      syncTerrainRef.current(); // synthetic & maptiler: khôi phục DEM theo terrainOn
    }
  };

  // Dựng lại toàn bộ layer tuỳ biến sau khi style nền được set (lần đầu HOẶC sau khi đổi
  // basemap — setStyle xoá sạch source/layer/terrain nên phải tái tạo). Dùng chung cho cả 2.
  setupAfterStyleRef.current = () => {
    const map = mapRef.current;
    if (!map) return;
    // Source + layer fill-extrusion (rỗng; dữ liệu đổ lại trong applyScene).
    if (!map.getSource(BUILDINGS_SRC)) {
      map.addSource(BUILDINGS_SRC, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    }
    if (!map.getLayer(BUILDINGS_LAYER)) {
      map.addLayer({
        id: BUILDINGS_LAYER,
        type: "fill-extrusion",
        source: BUILDINGS_SRC,
        paint: {
          "fill-extrusion-color": ["get", "base_color"],
          "fill-extrusion-height": ["get", "height"],
          "fill-extrusion-base": ["get", "min_height"],
          // Đục HOÀN TOÀN: ghi depth sạch -> mặt nước trong suốt blend lên không bị nhập nhằng.
          "fill-extrusion-opacity": 1.0,
        },
      });
    }
    // Buộc add lại custom layer (instance cũ đã bị setStyle gỡ + onRemove dọn GL).
    addedRef.current = false;
    propsLayerRef.current = null;
    applySceneRef.current();
    syncTilesRef.current();
    syncTerrainRef.current();
  };

  // Đổ scene khi worker trả về (map có thể đã load xong từ trước).
  useEffect(() => {
    applySceneRef.current();
  }, [scene]);

  // Đổi basemap -> setStyle rồi dựng lại layer khi style mới load xong.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoadedRef.current || basemap === basemapRef.current) return;
    basemapRef.current = basemap;
    // Gỡ overlay deck trước khi đổi style (sẽ được syncTiles re-add nếu đang ở chế độ google).
    if (deckOverlayRef.current) {
      try {
        map.removeControl(deckOverlayRef.current as unknown as maplibre.IControl);
      } catch {
        /* noop */
      }
      deckOverlayRef.current = null;
    }
    map.setStyle(BASEMAPS[basemap]);
    map.once("styledata", () => setupAfterStyleRef.current());
  }, [basemap]);

  // Đổi nguồn cảnh / DEM -> đồng bộ lại.
  useEffect(() => {
    syncTilesRef.current();
  }, [sceneSource]);
  useEffect(() => {
    syncTerrainRef.current();
  }, [sceneSource, terrainOn, terrainExaggeration]);

  // Khởi tạo bản đồ 1 lần.
  useEffect(() => {
    if (!mapContainerRef.current) return;

    const map = new maplibre.Map({
      container: mapContainerRef.current,
      style: BASEMAPS[basemapRef.current],
      center: SCENE_CENTER,
      zoom: 15,
      pitch: 62, // nghiêng mạnh để thấy nước dâng lên chân các khối nhà
      bearing: -18,
      maxPitch: 70, // hạn chế nhìn sát chân trời (vùng z-fighting mặt nước/đất tệ nhất)
      trackResize: true,
    });
    map.addControl(new NavigationControl({ visualizePitch: true }), "top-right");
    mapRef.current = map;

    map.on("load", () => {
      mapLoadedRef.current = true;
      setupAfterStyleRef.current(); // dựng buildings + custom layers + tiles/terrain
    });

    return () => {
      mapLoadedRef.current = false;
      addedRef.current = false;
      if (deckOverlayRef.current) {
        try {
          map.removeControl(deckOverlayRef.current as unknown as maplibre.IControl);
        } catch {
          /* noop */
        }
        deckOverlayRef.current = null;
      }
      propsLayerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  return (
    <div style={{ flex: 1, position: "relative", height: "100vh" }}>
      <div ref={mapContainerRef} style={{ width: "100%", height: "100%" }} />
      {sceneSource === "google" && (
        <div
          style={{
            position: "absolute",
            bottom: 6,
            left: 8,
            fontSize: "0.72rem",
            color: "#cbd5e1",
            background: "rgba(15,23,42,0.6)",
            padding: "2px 8px",
            borderRadius: 4,
            pointerEvents: "none",
          }}
        >
          Dữ liệu ảnh 3D © Google
        </div>
      )}
      <MapLoadingOverlay visible={isLoading} label="Đang dựng bản sao số đô thị trong worker..." />
    </div>
  );
};
