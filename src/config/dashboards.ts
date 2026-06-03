import { lazy } from "react";

// Single source of truth cho navigation + landing card. Thêm dashboard mới = thêm 1 entry,
// landing tự pick up, route tự register. Không touch App.tsx hay HomePage.tsx.

export type CategoryId = "fleet" | "spatial" | "storage";

export interface CategoryDef {
  id: CategoryId;
  label: string;
  icon: string;
  desc: string;
  accent: string; // màu cho section header trên landing
}

export interface DashboardDef {
  id: string;
  label: string;
  desc: string;
  icon: string;
  accent: string;
  category: CategoryId;
  path: string;
  badges?: string[];
  component: React.LazyExoticComponent<React.FC>;
}

export const CATEGORIES: CategoryDef[] = [
  {
    id: "fleet",
    label: "Fleet Operations",
    icon: "🚗",
    desc: "Real-time tracking, streaming, density",
    accent: "#38bdf8",
  },
  {
    id: "spatial",
    label: "Spatial Analysis",
    icon: "📍",
    desc: "Geofencing, KNN, 3D visualization",
    accent: "#a855f7",
  },
  {
    id: "storage",
    label: "Storage & Sync",
    icon: "💾",
    desc: "Offline-first, queue, conflict resolution",
    accent: "#ea580c",
  },
];

// `lazy(() => import().then(m => ({ default: m.Named })))` cho phép giữ named export
// ở các component dashboard hiện tại — không phải sửa 6 file.
export const DASHBOARDS: DashboardDef[] = [
  {
    id: "2d",
    label: "2D Fleet Tracking",
    desc: "100k drivers di chuyển real-time, viewport filter qua Worker SoA",
    icon: "🛵",
    accent: "#38bdf8",
    category: "fleet",
    path: "/2d-tracking",
    badges: ["100k", "5s tick", "Worker"],
    component: lazy(() =>
      import("../components/MapContainer").then((m) => ({ default: m.MapDashboard })),
    ),
  },
  {
    id: "motion",
    label: "MotionStream Fleet",
    desc: "Drip stream 3s + lerp 60fps cho cảm giác di chuyển mượt",
    icon: "🚕",
    accent: "#34d399",
    category: "fleet",
    path: "/motion-stream",
    badges: ["60fps lerp", "Object pool", "Hysteresis"],
    component: lazy(() =>
      import("../components/MotionStream").then((m) => ({ default: m.MotionStreamDashboard })),
    ),
  },
  {
    id: "playback",
    label: "History Playback",
    desc: "Tua lại 5k xe × 300s · cube không-thời gian + dò va chạm < 5m bằng spatial grid",
    icon: "⏮️",
    accent: "#a78bfa",
    category: "fleet",
    path: "/history-playback",
    badges: ["5k × 300s", "Space-time cube", "Proximity grid"],
    component: lazy(() =>
      import("../components/HistoryPlayback").then((m) => ({ default: m.HistoryPlaybackDashboard })),
    ),
  },
  {
    id: "bigdata",
    label: "Big Data Geo-Engine",
    desc: "1M points · GPU heatmap + Supercluster auto-zoom",
    icon: "🌋",
    accent: "#f43f5e",
    category: "fleet",
    path: "/big-data",
    badges: ["1M points", "GPU", "Supercluster"],
    component: lazy(() =>
      import("../components/BigDataSpatial").then((m) => ({ default: m.BigDataDashboard })),
    ),
  },
  {
    id: "tsp",
    label: "Route Optimizer",
    desc: "TSP 20 điểm · OSRM đường thật + Held-Karp trong Worker + render đa phương thức",
    icon: "🧭",
    accent: "#818cf8",
    category: "spatial",
    path: "/route-optimizer",
    badges: ["OSRM", "Held-Karp", "Multi-modal"],
    component: lazy(() =>
      import("../components/RouteOptimizer").then((m) => ({ default: m.RouteOptimizerDashboard })),
    ),
  },
  {
    id: "geofence",
    label: "Geofence Monitor",
    desc: "Toàn VN · 50k xe · 1000 vùng cấm · spatial grid + lọc 2 tầng (bbox + Turf PiP) trong Worker",
    icon: "🚧",
    accent: "#f87171",
    category: "spatial",
    path: "/geofencing",
    badges: ["50k", "Grid index", "Turf PiP"],
    component: lazy(() =>
      import("../components/Geofencing").then((m) => ({ default: m.GeofencingDashboard })),
    ),
  },
  {
    id: "spatial",
    label: "Spatial Analysis",
    desc: "Radius scan + Find Nearest K với kdbush + geokdbush",
    icon: "🎯",
    accent: "#a855f7",
    category: "spatial",
    path: "/spatial",
    badges: ["kdbush", "KNN", "Haversine"],
    component: lazy(() =>
      import("../components/SpatialAnalysis").then((m) => ({
        default: m.SpatialAnalysisDashboard,
      })),
    ),
  },
  {
    id: "3d",
    label: "3D Buildings",
    desc: "100k fill-extrusion với viewport bbox filter",
    icon: "🏙️",
    accent: "#10b981",
    category: "spatial",
    path: "/3d-buildings",
    badges: ["100k", "fill-extrusion", "GPU"],
    component: lazy(() =>
      import("../components/MapDashboard3d").then((m) => ({ default: m.MapDashboard3d })),
    ),
  },
  {
    id: "flood",
    label: "3D Digital Twin · Ngập lụt",
    desc: "Custom WebGL Shader mô phỏng nước dâng lên toà nhà 3D + Instanced trees/barriers",
    icon: "🌊",
    accent: "#0ea5e9",
    category: "spatial",
    path: "/flood-twin",
    badges: ["WebGL Shader", "Instanced", "60 FPS"],
    component: lazy(() =>
      import("../components/FloodSim").then((m) => ({ default: m.FloodSimDashboard })),
    ),
  },
  {
    id: "cesium-flood",
    label: "Cesium Digital Twin · Ngập lụt",
    desc: "CesiumJS · khối nước thể tích thực + CallbackProperty 60fps + IDW từ 50 cảm biến IoT",
    icon: "🌐",
    accent: "#0891b2",
    category: "spatial",
    path: "/cesium-flood-twin",
    badges: ["CesiumJS", "3D Tiles", "IoT WebSocket"],
    component: lazy(() =>
      import("../components/CesiumFloodTwin").then((m) => ({ default: m.CesiumFloodTwinDashboard })),
    ),
  },
  {
    id: "offline",
    label: "Offline Sync",
    desc: "IndexedDB + queue sync + conflict resolution version-based",
    icon: "📡",
    accent: "#ea580c",
    category: "storage",
    path: "/offline-sync",
    badges: ["IndexedDB", "CRDT-like", "WebSocket"],
    component: lazy(() =>
      import("../components/OfflineSync").then((m) => ({ default: m.OfflineSyncDashboard })),
    ),
  },
];

export const getCategoryById = (id: CategoryId): CategoryDef | undefined =>
  CATEGORIES.find((c) => c.id === id);

export const getDashboardByPath = (path: string): DashboardDef | undefined =>
  DASHBOARDS.find((d) => d.path === path);

export const getDashboardsByCategory = (categoryId: CategoryId): DashboardDef[] =>
  DASHBOARDS.filter((d) => d.category === categoryId);
