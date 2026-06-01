import Supercluster from "supercluster";
import type { Feature, Point } from "geojson";
import { generateMegaSoA, type MegaSoA } from "../utils/bigDataHelpers";

// Worker model: master SoA state + supercluster index. Mỗi tick (3s):
//  1. Mutate positions toward destinations (SoA in-place, không alloc).
//  2. Rebuild supercluster index từ positions hiện tại (~500ms cho 1M).
//  3. getClusters(currentBbox, currentZoom) → vài trăm cluster features.
//  4. JSON.stringify (~5ms) → Blob → URL → post.
// Main thread NEVER nhận 1M FC — chỉ vài trăm features clustered theo viewport hiện tại.

const STEP_DEG = 0.0006;
const ARRIVED_DEG = 0.0015;
const TICK_MS = 3000;
const CLUSTER_RADIUS = 30;
const CLUSTER_MAX_ZOOM = 14;

interface PointProps {
  idx: number;
  intensity: number;
}
interface ClusterAggProps {
  intensity_sum: number;
}

let soa: MegaSoA | null = null;
let count = 0;

let supercluster: Supercluster<PointProps, ClusterAggProps> | null = null;
let currentBbox: [number, number, number, number] | null = null;
let currentZoom = 5;
let isInteracting = false;
let streamIntervalId: ReturnType<typeof setInterval> | null = null;

const post = self.postMessage as (message: unknown) => void;

self.onmessage = (event: MessageEvent) => {
  const { type, payload } = event.data;

  switch (type) {
    case "INIT_DATA": {
      console.time(`init SoA ${payload.count.toLocaleString()}`);
      soa = generateMegaSoA(payload.count);
      count = payload.count;
      console.timeEnd(`init SoA ${payload.count.toLocaleString()}`);

      currentBbox = payload.bbox;
      currentZoom = payload.zoom;
      rebuildAndPost("init");
      break;
    }

    case "UPDATE_VIEW":
      currentBbox = payload.bbox;
      currentZoom = payload.zoom;
      // View đổi nhưng positions chưa đổi → re-query supercluster cũ (không rebuild).
      if (!isInteracting) queryAndPost("view");
      break;

    case "SET_INTERACTING":
      isInteracting = payload.isActive;
      if (!isInteracting) queryAndPost("after-interact");
      break;

    case "SET_STREAMING":
      if (payload.isActive) startStreaming();
      else stopStreaming();
      break;
  }
};

// Build features inline từ SoA. Mỗi tick alloc N feature object → ~50MB/tick cho 1M,
// GC sẽ thu lại sau khi supercluster.load consume xong. Trade-off vs SoA cũ trong index:
// supercluster cần Feature[], không nhận SoA trực tiếp.
const buildFeatures = (): Feature<Point, PointProps>[] => {
  if (!soa) return [];
  const features = new Array(count);
  for (let i = 0; i < count; i++) {
    features[i] = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [soa.lngs[i], soa.lats[i]] },
      properties: { idx: i, intensity: soa.intensities[i] },
    };
  }
  return features;
};

const rebuildAndPost = (stage: string) => {
  if (!soa || !currentBbox) return;
  console.time(`build+load ${stage}`);
  const features = buildFeatures();

  // (Re)build supercluster index. Với 1M ~500ms ở worker, off main thread.
  // map/reduce: aggregate intensity_sum cho heatmap weight ở zoom thấp.
  supercluster = new Supercluster<PointProps, ClusterAggProps>({
    radius: CLUSTER_RADIUS,
    maxZoom: CLUSTER_MAX_ZOOM,
    map: (props) => ({ intensity_sum: props.intensity }),
    reduce: (acc, props) => {
      acc.intensity_sum += props.intensity_sum;
    },
  });
  supercluster.load(features);
  console.timeEnd(`build+load ${stage}`);

  queryAndPost(stage);
};

const queryAndPost = (stage: string) => {
  if (!supercluster || !currentBbox) return;
  console.time(`query+pack ${stage}`);

  const clusters = supercluster.getClusters(currentBbox, Math.floor(currentZoom));

  // Pre-bake expansion_zoom vào cluster features → main không cần round-trip để zoom in.
  for (const feat of clusters) {
    const props = feat.properties as unknown as Record<string, unknown>;
    if (props.cluster) {
      try {
        const expansionZoom = supercluster.getClusterExpansionZoom(props.cluster_id as number);
        props.expansion_zoom = expansionZoom;
      } catch {
        /* ignore */
      }
    }
  }

  console.timeEnd(`query+pack ${stage}`);

  // Post features array trực tiếp (structured-clone). Cho ~vài trăm-vài k feature size nhỏ:
  // ~5ms clone cost, không cần Blob URL detour. Main detect mode (cluster/raw) qua
  // feature properties.cluster.
  post({
    type: "DATA_UPDATED",
    features: clusters,
    total: count,
    viewportCount: clusters.length,
    stage,
  });
};

// Tick: mutate positions toward destinations. Logic mirror dataParser.worker.ts.
const tick = () => {
  if (!soa) return;
  console.time("tick mutate");
  for (let i = 0; i < count; i++) {
    const dLng = soa.destLngs[i] - soa.lngs[i];
    const dLat = soa.destLats[i] - soa.lats[i];
    const dist = Math.hypot(dLng, dLat);

    if (dist < ARRIVED_DEG) {
      // Gán đích mới: dịch ngẫu nhiên trong bán kính ~0.1° (~11km)
      soa.destLngs[i] = soa.lngs[i] + (Math.random() - 0.5) * 0.2;
      soa.destLats[i] = soa.lats[i] + (Math.random() - 0.5) * 0.2;
      continue;
    }

    soa.lngs[i] += (dLng / dist) * STEP_DEG + (Math.random() - 0.5) * 0.00008;
    soa.lats[i] += (dLat / dist) * STEP_DEG + (Math.random() - 0.5) * 0.00008;
  }
  console.timeEnd("tick mutate");

  rebuildAndPost("tick");
};

const startStreaming = () => {
  if (streamIntervalId) return;
  streamIntervalId = setInterval(tick, TICK_MS);
};

const stopStreaming = () => {
  if (streamIntervalId) {
    clearInterval(streamIntervalId);
    streamIntervalId = null;
  }
};
