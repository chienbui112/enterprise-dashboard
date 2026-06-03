// MapContainerCesium.tsx
// Thế giới 3D CesiumJS cho bản sao số đô thị ngập lụt — MÔ HÌNH NGẬP ĐÚNG VẬT LÝ + NHÀ THẬT.
//
//   - Bật ĐỊA HÌNH THẬT (Cesium World Terrain). Sample 1 lưới cao độ -> nội suy song tuyến (bilinear)
//     cho mọi điểm (hố ga, chân nhà) -> nhanh, không phụ thuộc số lượng nhà.
//   - NHÀ THẬT: đọc public/hn_buildings.geojson trong Web Worker (file ~88MB, lọc theo vùng + giới
//     hạn số lượng), dựng khối 3D bằng cách EXTRUDE đa giác chân nhà từ cao độ địa hình lên
//     (height = building_l*3.4m, mặc định 4.5m). Gộp TẤT CẢ vào MỘT Primitive (PerInstanceColor +
//     id theo chỉ số) -> 1 draw call, pick được từng nhà.
//   - NƯỚC: khối thể tích ở cao độ tuyệt đối W + depthTestAgainstTerrain -> vùng trũng ngập trước,
//     đường cắt nước–thân nhà sắc nét. W gắn CallbackProperty (60 FPS, không re-render).
//   - CLICK: thước đo bật -> đo cao độ; thước đo tắt -> bấm nhà để xem properties.
//
// TẠM TẮT: đổi màu nhà theo ngập + cảnh báo (ripple).

import { useEffect, useRef } from "react";
import * as Cesium from "cesium";
// Extension la bàn (compass quả cầu) + zoom + thước khoảng cách cho Cesium. Tự import CSS riêng.
import CesiumNavigation from "cesium-navigation-es6";
import { CITY_CENTER, SIM_HALF_LON, SIM_HALF_LAT, BASEMAP_OPTIONS, type BasemapId, type FloodController } from "../../utils/cesiumFloodHelpers";

// Toà nhà tối thiểu do worker trả về.
interface LoadedBuilding {
  ring: number[]; // [lon,lat, lon,lat, ...]
  heightM: number;
  cLon: number;
  cLat: number;
  props: Record<string, unknown>;
}

export interface MeasureResult {
  lon: number;
  lat: number;
  terrainElevation: number;
  pointElevation: number;
  waterElevation: number;
  waterDepth: number;
  buildingHeight: number | null;
  buildingSubmersion: number | null;
}

export type TerrainStatus = "idle" | "loading" | "ready" | "error";

const MAX_BUILDINGS = 18000; // trần render (gộp 1 Primitive); vượt thì worker cắt bớt
const SAMPLE_GRID = 48; // lưới sample cao độ địa hình (bilinear)

const imageryLayerFor = (basemap: BasemapId): Cesium.ImageryLayer => {
  const opt = BASEMAP_OPTIONS.find((b) => b.id === basemap) ?? BASEMAP_OPTIONS[0];
  return new Cesium.ImageryLayer(new Cesium.UrlTemplateImageryProvider({ url: opt.url, credit: "© OpenStreetMap · © CARTO", maximumLevel: 19 }));
};

interface Props {
  controller: FloodController;
  ionToken: string | null;
  waterEffect: boolean;
  basemap: BasemapId;
  measureMode: boolean;
  onMeasure: (r: MeasureResult) => void;
  onBuildingClick: (props: Record<string, unknown>) => void;
  onTerrainStatus: (s: TerrainStatus) => void;
  onWaterRange: (rangeMeters: number) => void;
  onBuildingCount: (kept: number, total: number) => void;
  onReady: () => void;
}

const RIPPLE_PERIOD = 1.6; // giây cho một vòng sóng cảnh báo lan ra ở hố ga
const RIPPLE_MAX = 450; // bán kính tối đa (m)

// Màu per-instance cho nhà (byte [r,g,b,a]) — cập nhật cảnh báo ngập không cần dựng lại hình học.
const BLD_DRY = Cesium.ColorGeometryInstanceAttribute.toValue(Cesium.Color.fromCssColorString("#d3d9e2"));
const BLD_ORANGE = Cesium.ColorGeometryInstanceAttribute.toValue(Cesium.Color.fromCssColorString("#f59e0b"));
const BLD_RED = Cesium.ColorGeometryInstanceAttribute.toValue(Cesium.Color.fromCssColorString("#ef4444"));

const statusColor = (code: number, out: Cesium.Color): Cesium.Color => {
  if (code === 2) {
    out.red = 0.94;
    out.green = 0.27;
    out.blue = 0.27;
  } else if (code === 1) {
    out.red = 0.96;
    out.green = 0.62;
    out.blue = 0.04;
  } else {
    out.red = 0.13;
    out.green = 0.77;
    out.blue = 0.37;
  }
  out.alpha = 1;
  return out;
};

export const MapContainerCesium: React.FC<Props> = ({
  controller,
  ionToken,
  waterEffect,
  basemap,
  measureMode,
  onMeasure,
  onBuildingClick,
  onTerrainStatus,
  onWaterRange,
  onBuildingCount,
  onReady,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Cesium.Viewer | null>(null);

  const waterEffectRef = useRef(waterEffect);
  useEffect(() => {
    waterEffectRef.current = waterEffect;
  }, [waterEffect]);

  const measureModeRef = useRef(measureMode);
  const onMeasureRef = useRef(onMeasure);
  const onBuildingClickRef = useRef(onBuildingClick);
  useEffect(() => {
    onMeasureRef.current = onMeasure;
  }, [onMeasure]);
  useEffect(() => {
    onBuildingClickRef.current = onBuildingClick;
  }, [onBuildingClick]);
  useEffect(() => {
    measureModeRef.current = measureMode;
    const viewer = viewerRef.current;
    if (viewer && !viewer.isDestroyed()) viewer.scene.canvas.style.cursor = measureMode ? "crosshair" : "";
  }, [measureMode]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;
    viewer.imageryLayers.removeAll();
    viewer.imageryLayers.add(imageryLayerFor(basemap));
  }, [basemap]);

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;

    if (ionToken) Cesium.Ion.defaultAccessToken = ionToken;

    const viewer = new Cesium.Viewer(containerRef.current, {
      baseLayer: imageryLayerFor(basemap),
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      requestRenderMode: false,
    });
    viewerRef.current = viewer;
    viewer.clock.shouldAnimate = true;
    viewer.scene.globe.depthTestAgainstTerrain = true; // nước chỉ hiện ở chỗ trũng
    viewer.scene.logarithmicDepthBuffer = false; // tránh nhiễu z với polygon nước lớn
    // Mốc thời gian cho animation ping cảnh báo ở hố ga.
    const startTime = Cesium.JulianDate.clone(viewer.clock.currentTime);

    const west = CITY_CENTER[0] - SIM_HALF_LON;
    const south = CITY_CENTER[1] - SIM_HALF_LAT;
    const east = CITY_CENTER[0] + SIM_HALF_LON;
    const north = CITY_CENTER[1] + SIM_HALF_LAT;

    // La bàn (compass quả cầu) + nút zoom + thước khoảng cách (extension cesium-navigation-es6).
    // "Về vị trí ban đầu" = double-click tâm la bàn -> bay tới defaultResetView.
    const navigation = new CesiumNavigation(viewer, {
      defaultResetView: Cesium.Rectangle.fromDegrees(west, south, east, north),
      enableCompass: true,
      enableZoomControls: false,
      enableDistanceLegend: true,
      enableCompassOuterRing: true,
    });

    // 1) MẶT NƯỚC: khối thể tích, mặt trên = W (CallbackProperty), đáy chôn dưới đất.
    viewer.entities.add({
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray([west, south, east, south, east, north, west, north])),
        // Ẩn khối thể tích khi bật shimmer (Water Material) -> chỉ một mặt nước, tránh "2 vạch"/z-fight.
        show: new Cesium.CallbackProperty(
          () => !waterEffectRef.current && controller.terrainReady && controller.waterElevation > controller.minTerrain + 0.05,
          false,
        ),
        perPositionHeight: false,
        granularity: Cesium.Math.toRadians(0.003),
        height: new Cesium.CallbackProperty(() => controller.lowBase, false),
        extrudedHeight: new Cesium.CallbackProperty(() => controller.waterElevation, false),
        material: new Cesium.ColorMaterialProperty(new Cesium.Color(0.16, 0.5, 0.86, 0.5)),
        outline: false,
        closeTop: true,
        closeBottom: false,
      },
    });

    // 2) Camera nghiêng.
    viewer.scene.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(CITY_CENTER[0], CITY_CENTER[1] - 0.03, 3500),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-35), roll: 0 },
    });

    // 3) Clock: lerp W + (khi bật) nâng lớp shimmer + CẢNH BÁO MÀU NHÀ ngập.
    let prevTime = Cesium.JulianDate.clone(viewer.clock.currentTime);
    const waterSkinRef: { current: Cesium.Primitive | null } = { current: null };
    const upVec = new Cesium.Cartesian3();
    const skinTranslation = new Cesium.Cartesian3();
    const skinMatrix = new Cesium.Matrix4();

    // Nhà ngập đổi màu: cập nhật thuộc tính màu per-instance (~5 Hz, chỉ nhà đổi trạng thái).
    //   ngập quá nóc -> ĐỎ; ngập một phần thân -> CAM; khô -> xám.
    let buildingPrimitive: Cesium.Primitive | null = null;
    let buildingColorState: Int8Array | null = null;
    let bColorAcc = 0;
    const updateBuildingColors = () => {
      if (!buildingPrimitive || !buildingPrimitive.ready || !buildingColorState) return;
      const W = controller.waterElevation;
      for (let b = 0; b < buildingMeta.length; b++) {
        const m = buildingMeta[b];
        let state = 0;
        if (W >= m.baseElev + m.heightM) state = 2;
        else if (W > m.baseElev + 0.1) state = 1;
        if (state === buildingColorState[b]) continue;
        buildingColorState[b] = state;
        const attrs = buildingPrimitive.getGeometryInstanceAttributes(b);
        if (attrs) attrs.color = state === 2 ? BLD_RED : state === 1 ? BLD_ORANGE : BLD_DRY;
      }
    };

    const tickListener = viewer.clock.onTick.addEventListener((clock) => {
      let dt = Cesium.JulianDate.secondsDifference(clock.currentTime, prevTime);
      if (dt < 0 || dt > 0.5) dt = 1 / 60;
      prevTime = Cesium.JulianDate.clone(clock.currentTime);
      controller.tick(dt);

      const skin = waterSkinRef.current;
      if (skin) {
        const W = controller.waterElevation;
        const visible = waterEffectRef.current && controller.terrainReady && W > controller.minTerrain + 0.05;
        skin.show = visible;
        if (visible) {
          Cesium.Cartesian3.multiplyByScalar(upVec, W - controller.minTerrain, skinTranslation);
          Cesium.Matrix4.fromTranslation(skinTranslation, skinMatrix);
          skin.modelMatrix = skinMatrix;
        }
      }

      if (buildingPrimitive) {
        bColorAcc += dt;
        if (bColorAcc >= 0.2) {
          bColorAcc = 0;
          updateBuildingColors();
        }
      }
    });

    // 3b) Thông tin nhà / thước đo dùng chung 1 handler LEFT_CLICK.
    let buildingMeta: { heightM: number; baseElev: number; props: Record<string, unknown> }[] = [];
    const measureEntity = viewer.entities.add({
      show: false,
      position: Cesium.Cartesian3.fromDegrees(CITY_CENTER[0], CITY_CENTER[1], 0),
      point: {
        pixelSize: 10,
        color: Cesium.Color.YELLOW,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: "",
        font: "12px monospace",
        fillColor: Cesium.Color.WHITE,
        showBackground: true,
        backgroundColor: new Cesium.Color(0, 0, 0, 0.72),
        pixelOffset: new Cesium.Cartesian2(0, -20),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });

    const measureHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    measureHandler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      if (viewer.isDestroyed()) return;
      const picked = viewer.scene.pick(movement.position);
      const buildingIdx = Cesium.defined(picked) && typeof picked.id === "number" && buildingMeta[picked.id] ? (picked.id as number) : -1;

      // Thước đo TẮT: bấm nhà -> xem properties.
      if (!measureModeRef.current) {
        if (buildingIdx >= 0) onBuildingClickRef.current?.(buildingMeta[buildingIdx].props);
        return;
      }

      // Thước đo BẬT: đọc cao độ đất + nước + (nếu trúng nhà) chiều cao + ngập thân.
      const cartesian = viewer.scene.pickPosition(movement.position);
      if (!Cesium.defined(cartesian)) return;
      const carto = Cesium.Cartographic.fromCartesian(cartesian);
      const lon = Cesium.Math.toDegrees(carto.longitude);
      const lat = Cesium.Math.toDegrees(carto.latitude);
      const pointElevation = carto.height;
      const th = viewer.scene.globe.getHeight(carto);
      const terrainElevation = typeof th === "number" ? th : 0;
      const waterElevation = controller.waterElevation;
      const waterDepth = Math.max(0, waterElevation - terrainElevation);

      let buildingHeight: number | null = null;
      let buildingSubmersion: number | null = null;
      if (buildingIdx >= 0) {
        const m = buildingMeta[buildingIdx];
        buildingHeight = m.heightM;
        buildingSubmersion = Math.max(0, Math.min(m.heightM, waterElevation - m.baseElev));
      }

      measureEntity.position = new Cesium.ConstantPositionProperty(cartesian);
      const lines = [
        `📍 ${lat.toFixed(5)}, ${lon.toFixed(5)}`,
        `Đất: ${terrainElevation.toFixed(1)} m · Nước: ${waterElevation.toFixed(1)} m`,
        `Ngập tại điểm: ${waterDepth.toFixed(2)} m`,
      ];
      if (buildingHeight != null && buildingSubmersion != null) {
        lines.push(`Nhà cao ${buildingHeight.toFixed(1)} m · ngập thân ${buildingSubmersion.toFixed(1)} m`);
      }
      if (measureEntity.label) measureEntity.label.text = new Cesium.ConstantProperty(lines.join("\n"));
      measureEntity.show = true;
      onMeasureRef.current?.({
        lon,
        lat,
        terrainElevation,
        pointElevation,
        waterElevation,
        waterDepth,
        buildingHeight,
        buildingSubmersion,
      });
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    // 4) Async: nạp nhà (worker) song song với terrain; sample lưới cao độ; dựng nhà + hố ga + shimmer.
    (async () => {
      // Khởi động worker nạp nhà SỚM (overlap với việc tải terrain).
      const fileUrl = `${location.origin}${import.meta.env.BASE_URL}hn_buildings.geojson`;
      const loaderWorker = new Worker(new URL("../../workers/buildingsLoader.worker.ts", import.meta.url), {
        type: "module",
      });
      const buildingsPromise = new Promise<LoadedBuilding[]>((resolve, reject) => {
        loaderWorker.onmessage = (ev: MessageEvent) => {
          if (ev.data?.type === "BUILDINGS_LOADED") {
            onBuildingCount(ev.data.kept, ev.data.total);
            resolve(ev.data.buildings as LoadedBuilding[]);
          } else if (ev.data?.type === "BUILDINGS_ERROR") {
            reject(new Error(ev.data.message));
          }
        };
      });
      loaderWorker.postMessage({ type: "LOAD", url: fileUrl, west, south, east, north, maxCount: MAX_BUILDINGS });

      // a) Địa hình thật.
      let terrainOk = false;
      if (ionToken) {
        onTerrainStatus("loading");
        try {
          const terrain = await Cesium.createWorldTerrainAsync();
          if (cancelled || viewer.isDestroyed()) return;
          viewer.terrainProvider = terrain;
          terrainOk = true;
        } catch {
          onTerrainStatus("error");
        }
      } else {
        onTerrainStatus("idle");
      }

      // b) Sample lưới cao độ địa hình -> bilinear.
      const G = SAMPLE_GRID;
      const gridCartos: Cesium.Cartographic[] = [];
      for (let r = 0; r < G; r++) {
        for (let c = 0; c < G; c++) {
          const lon = west + ((east - west) * c) / (G - 1);
          const lat = south + ((north - south) * r) / (G - 1);
          gridCartos.push(Cesium.Cartographic.fromDegrees(lon, lat));
        }
      }
      if (terrainOk) {
        try {
          await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, gridCartos);
          if (cancelled || viewer.isDestroyed()) return;
          onTerrainStatus("ready");
        } catch {
          onTerrainStatus("error");
        }
      }
      const gridElev = new Float64Array(G * G);
      let minT = Infinity;
      let maxT = -Infinity;
      for (let i = 0; i < gridElev.length; i++) {
        const h = Number.isFinite(gridCartos[i].height) ? gridCartos[i].height : 0;
        gridElev[i] = h;
        if (h < minT) minT = h;
        if (h > maxT) maxT = h;
      }
      if (!Number.isFinite(minT)) {
        minT = 0;
        maxT = 0;
      }
      const baseAt = (lon: number, lat: number): number => {
        const fx = Math.min(G - 1, Math.max(0, ((lon - west) / (east - west)) * (G - 1)));
        const fy = Math.min(G - 1, Math.max(0, ((lat - south) / (north - south)) * (G - 1)));
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const x1 = Math.min(x0 + 1, G - 1);
        const y1 = Math.min(y0 + 1, G - 1);
        const tx = fx - x0;
        const ty = fy - y0;
        const e0 = gridElev[y0 * G + x0] * (1 - tx) + gridElev[y0 * G + x1] * tx;
        const e1 = gridElev[y1 * G + x0] * (1 - tx) + gridElev[y1 * G + x1] * tx;
        return e0 * (1 - ty) + e1 * ty;
      };

      const sensorElev: number[] = [];
      for (let i = 0; i < controller.stations.length; i++) sensorElev.push(baseAt(controller.sLon[i], controller.sLat[i]));
      controller.setTerrainSamples(minT, maxT, sensorElev);
      onWaterRange(controller.waterRange);

      // c) Lớp Water Material shimmer (dựng tại minT, nâng theo W).
      Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(Cesium.Cartesian3.fromDegrees(CITY_CENTER[0], CITY_CENTER[1], minT), upVec);
      const waterMaterial = new Cesium.Material({
        fabric: {
          type: "Water",
          uniforms: {
            baseWaterColor: new Cesium.Color(0.1, 0.42, 0.72, 0.5),
            blendColor: new Cesium.Color(0.1, 0.45, 0.78, 0.6),
            normalMap: Cesium.buildModuleUrl("Assets/Textures/waterNormals.jpg"),
            frequency: 1000.0,
            animationSpeed: 0.02,
            amplitude: 8.0,
            specularIntensity: 0.8,
          },
        },
      });
      const waterSkin = new Cesium.Primitive({
        geometryInstances: new Cesium.GeometryInstance({
          geometry: new Cesium.RectangleGeometry({
            rectangle: Cesium.Rectangle.fromDegrees(west, south, east, north),
            height: minT,
            // Chia mịn để mặt shimmer BÁM ellipsoid (cong) như khối nước thể tích -> cùng cao độ W ở
            // mọi nơi, hết hiện tượng "2 vạch" do tấm phẳng cắt mặt cầu lệch nhau ở rìa.
            granularity: Cesium.Math.toRadians(0.003),
            vertexFormat: Cesium.EllipsoidSurfaceAppearance.VERTEX_FORMAT,
          }),
        }),
        appearance: new Cesium.EllipsoidSurfaceAppearance({ material: waterMaterial, aboveGround: true, translucent: true }),
        asynchronous: false,
        show: false,
      });
      viewer.scene.primitives.add(waterSkin);
      waterSkinRef.current = waterSkin;

      // d) NHÀ THẬT: chờ worker, dựng khối extrude gộp 1 Primitive (id = chỉ số để pick).
      let buildings: LoadedBuilding[] = [];
      try {
        buildings = await buildingsPromise;
      } catch {
        /* lỗi nạp -> không có nhà */
      } finally {
        loaderWorker.terminate();
      }
      if (cancelled || viewer.isDestroyed()) return;

      const gray = Cesium.Color.fromCssColorString("#d3d9e2");
      const instances: Cesium.GeometryInstance[] = [];
      buildingMeta = [];
      for (let b = 0; b < buildings.length; b++) {
        const bd = buildings[b];
        const base = baseAt(bd.cLon, bd.cLat);
        buildingMeta.push({ heightM: bd.heightM, baseElev: base, props: bd.props });
        instances.push(
          new Cesium.GeometryInstance({
            geometry: new Cesium.PolygonGeometry({
              polygonHierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(bd.ring)),
              perPositionHeight: false,
              height: base,
              extrudedHeight: base + bd.heightM,
              vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
            }),
            attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(gray) },
            id: b,
          }),
        );
      }
      if (instances.length > 0) {
        buildingPrimitive = new Cesium.Primitive({
          geometryInstances: instances,
          appearance: new Cesium.PerInstanceColorAppearance({ flat: false, translucent: false }),
          asynchronous: true, // tessellate trong worker pool của Cesium -> không treo main thread
        });
        viewer.scene.primitives.add(buildingPrimitive);
        buildingColorState = new Int8Array(buildingMeta.length); // 0 khô (khớp màu xám ban đầu)
      }

      // e) 50 hố ga: marker bám mặt đất + nhãn id, màu theo trạng thái + PING cảnh báo khi 'danger'.
      for (let i = 0; i < controller.stations.length; i++) {
        const st = controller.stations[i];
        const sScratch = new Cesium.Color();
        const baseZ = sensorElev[i];
        viewer.entities.add({
          position: Cesium.Cartesian3.fromDegrees(st.lon, st.lat, baseZ + 2),
          point: {
            pixelSize: 9,
            color: new Cesium.CallbackProperty(() => statusColor(controller.sensorStatusCode(i), sScratch), false),
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 1.5,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: {
            text: st.id,
            font: "10px sans-serif",
            fillColor: Cesium.Color.WHITE,
            showBackground: true,
            backgroundColor: new Cesium.Color(0, 0, 0, 0.5),
            pixelOffset: new Cesium.Cartesian2(0, -16),
            scaleByDistance: new Cesium.NearFarScalar(500, 1.0, 8000, 0.4),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });

        // VÒNG SÓNG XUNG KÍCH (ping) đỏ: chỉ hiện khi hố ga 'danger', bán kính lan + mờ dần.
        const rScratch = new Cesium.Color();
        viewer.entities.add({
          position: Cesium.Cartesian3.fromDegrees(st.lon, st.lat, baseZ + 0.5),
          ellipse: {
            semiMajorAxis: new Cesium.CallbackProperty((time) => {
              if (controller.sensorStatusCode(i) !== 2 || !time) return 0.1;
              const p = (Cesium.JulianDate.secondsDifference(time, startTime) % RIPPLE_PERIOD) / RIPPLE_PERIOD;
              return 4 + p * RIPPLE_MAX;
            }, false),
            semiMinorAxis: new Cesium.CallbackProperty((time) => {
              if (controller.sensorStatusCode(i) !== 2 || !time) return 0.1;
              const p = (Cesium.JulianDate.secondsDifference(time, startTime) % RIPPLE_PERIOD) / RIPPLE_PERIOD;
              return 4 + p * RIPPLE_MAX;
            }, false),
            material: new Cesium.ColorMaterialProperty(
              new Cesium.CallbackProperty((time) => {
                if (controller.sensorStatusCode(i) !== 2 || !time) {
                  rScratch.red = 1;
                  rScratch.green = 0.2;
                  rScratch.blue = 0.15;
                  rScratch.alpha = 0;
                  return rScratch;
                }
                const p = (Cesium.JulianDate.secondsDifference(time, startTime) % RIPPLE_PERIOD) / RIPPLE_PERIOD;
                rScratch.red = 1;
                rScratch.green = 0.16;
                rScratch.blue = 0.1;
                rScratch.alpha = (1 - p) * 0.55;
                return rScratch;
              }, false),
            ),
            height: baseZ + 0.4,
            outline: false,
          },
        });
      }

      if (!cancelled && !viewer.isDestroyed()) onReady();
    })();

    return () => {
      cancelled = true;
      tickListener();
      if (!measureHandler.isDestroyed()) measureHandler.destroy();
      try {
        (navigation as { destroy?: () => void }).destroy?.();
      } catch {
        /* extension tự dọn theo viewer */
      }
      if (!viewer.isDestroyed()) {
        viewer.entities.removeAll();
        viewer.destroy();
      }
      viewerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Điều hướng (compass quả cầu + zoom + thước khoảng cách) do extension cesium-navigation-es6 thêm
  // trực tiếp vào container của Viewer.
  return <div ref={containerRef} style={{ flex: 1, position: "relative", height: "100%" }} />;
};
