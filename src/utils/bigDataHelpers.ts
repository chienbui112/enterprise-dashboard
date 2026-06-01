// Seed centers ~ các đô thị lớn trên cả Vietnam + một số trục công nghiệp/giao thông.
// Mỗi seed có weight (tỉ lệ điểm) và sigma (độ phân tán degree, ~0.01 ≈ 1.1km).
// Hot spots tự nhiên + phân bố không đồng đều → heatmap có gradient rõ + cluster có cao điểm.
interface Seed {
  lng: number;
  lat: number;
  weight: number;
  sigma: number;
}

const SEEDS: Seed[] = [
  // ===== Miền Bắc =====
  { lng: 105.8342, lat: 21.0278, weight: 40, sigma: 0.05 },   // Hà Nội trung tâm (đậm đặc nhất)
  { lng: 105.78, lat: 21.04, weight: 14, sigma: 0.025 },      // Cầu Giấy
  { lng: 105.86, lat: 20.99, weight: 12, sigma: 0.03 },       // Hoàng Mai
  { lng: 105.78, lat: 20.97, weight: 8, sigma: 0.022 },       // Hà Đông
  { lng: 105.92, lat: 21.06, weight: 7, sigma: 0.025 },       // Long Biên
  { lng: 106.68, lat: 20.86, weight: 18, sigma: 0.045 },      // Hải Phòng
  { lng: 107.05, lat: 20.95, weight: 8, sigma: 0.05 },        // Hạ Long
  { lng: 106.2, lat: 21.18, weight: 6, sigma: 0.05 },         // Bắc Ninh
  { lng: 105.6, lat: 21.18, weight: 5, sigma: 0.07 },         // Vĩnh Phúc / Phú Thọ
  { lng: 105.9, lat: 20.7, weight: 4, sigma: 0.08 },          // Hà Nam / Nam Định
  { lng: 105.5, lat: 20.7, weight: 4, sigma: 0.09 },          // Hòa Bình

  // ===== Miền Trung =====
  { lng: 105.8, lat: 19.8, weight: 8, sigma: 0.06 },          // Thanh Hóa
  { lng: 105.69, lat: 18.68, weight: 7, sigma: 0.05 },        // Vinh
  { lng: 107.59, lat: 16.46, weight: 10, sigma: 0.05 },       // Huế
  { lng: 108.22, lat: 16.07, weight: 22, sigma: 0.06 },       // Đà Nẵng
  { lng: 108.45, lat: 15.58, weight: 6, sigma: 0.05 },        // Tam Kỳ / Hội An
  { lng: 109.19, lat: 13.78, weight: 8, sigma: 0.07 },        // Quy Nhơn
  { lng: 109.18, lat: 12.24, weight: 9, sigma: 0.06 },        // Nha Trang
  { lng: 108.45, lat: 11.94, weight: 7, sigma: 0.06 },        // Đà Lạt

  // ===== Miền Nam =====
  { lng: 106.66, lat: 10.78, weight: 45, sigma: 0.06 },       // TP HCM trung tâm (đông nhất)
  { lng: 106.7, lat: 10.83, weight: 18, sigma: 0.035 },       // Quận 3 / Tân Bình
  { lng: 106.62, lat: 10.74, weight: 14, sigma: 0.035 },      // Quận 5 / Quận 6
  { lng: 106.78, lat: 10.86, weight: 12, sigma: 0.04 },       // Thủ Đức
  { lng: 106.69, lat: 10.7, weight: 10, sigma: 0.035 },       // Quận 7
  { lng: 107.08, lat: 10.36, weight: 9, sigma: 0.06 },        // Vũng Tàu
  { lng: 106.83, lat: 11.32, weight: 6, sigma: 0.06 },        // Bình Dương
  { lng: 105.78, lat: 10.03, weight: 10, sigma: 0.07 },       // Cần Thơ
  { lng: 105.43, lat: 8.78, weight: 5, sigma: 0.08 },         // Cà Mau
  { lng: 106.4, lat: 10.36, weight: 5, sigma: 0.08 },         // Mỹ Tho / Bến Tre
];

// Box-Muller transform → 1 sample chuẩn N(0, 1)
const sampleGaussian = (): number => {
  const u1 = Math.random() || Number.MIN_VALUE;
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
};

const pickSeed = (totalWeight: number): Seed => {
  let r = Math.random() * totalWeight;
  for (const s of SEEDS) {
    r -= s.weight;
    if (r <= 0) return s;
  }
  return SEEDS[0];
};

// SoA (Struct-of-Arrays) version cho continuous simulation. Worker giữ master state SoA,
// mutate positions in-place mỗi tick, build features inline khi cần feed cho supercluster.
// Float32 đủ chính xác (~1.4m ở lat 21°), tiết kiệm 50% memory vs Float64.
export interface MegaSoA {
  lngs: Float32Array;
  lats: Float32Array;
  intensities: Uint8Array;
  destLngs: Float32Array;
  destLats: Float32Array;
}

export const generateMegaSoA = (count: number): MegaSoA => {
  const lngs = new Float32Array(count);
  const lats = new Float32Array(count);
  const intensities = new Uint8Array(count);
  const destLngs = new Float32Array(count);
  const destLats = new Float32Array(count);
  const totalWeight = SEEDS.reduce((sum, s) => sum + s.weight, 0);

  for (let i = 0; i < count; i++) {
    // Vị trí hiện tại: Gaussian quanh 1 seed
    const seed = pickSeed(totalWeight);
    lngs[i] = seed.lng + sampleGaussian() * seed.sigma;
    lats[i] = seed.lat + sampleGaussian() * seed.sigma;
    const dz = Math.hypot(lngs[i] - seed.lng, lats[i] - seed.lat) / seed.sigma;
    const intensityBase = Math.max(1, Math.round(10 - dz * 2));
    intensities[i] = Math.max(1, Math.min(10, intensityBase + Math.floor(Math.random() * 3 - 1)));

    // Đích: Gaussian quanh seed KHÁC → driver có hướng di chuyển giữa các thành phố
    const destSeed = pickSeed(totalWeight);
    destLngs[i] = destSeed.lng + sampleGaussian() * destSeed.sigma;
    destLats[i] = destSeed.lat + sampleGaussian() * destSeed.sigma;
  }

  return { lngs, lats, intensities, destLngs, destLats };
};

// Helper: build 1 feature ở vị trí Gaussian quanh seed, intensity bias theo distance từ tâm.
// Tách riêng để cả generateMegaDataset và generateMegaDatasetProgressive cùng dùng → distribution identical.
const makeFeature = (i: number, seed: Seed) => {
  const lng = seed.lng + sampleGaussian() * seed.sigma;
  const lat = seed.lat + sampleGaussian() * seed.sigma;
  const dz = Math.hypot(lng - seed.lng, lat - seed.lat) / seed.sigma;
  const intensityBase = Math.max(1, Math.round(10 - dz * 2));
  const intensity = Math.max(1, Math.min(10, intensityBase + Math.floor(Math.random() * 3 - 1)));
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lng, lat] },
    properties: { id: `node-${i}`, intensity },
  };
};

export const generateMegaDataset = (count: number) => {
  const features = new Array(count);
  const totalWeight = SEEDS.reduce((sum, s) => sum + s.weight, 0);
  console.time(`generate ${count.toLocaleString()}`);
  for (let i = 0; i < count; i++) {
    features[i] = makeFeature(i, pickSeed(totalWeight));
  }
  console.timeEnd(`generate ${count.toLocaleString()}`);
  return { type: "FeatureCollection", features };
};

// Progressive variant: sau khi tạo `checkpointAt` features đầu tiên thì gọi `onCheckpoint`
// với SAMPLE (slice). Worker dùng để post sample ngay → user thấy data sớm, không phải đợi full.
// Distribution của sample là PREFIX của full → khi upgrade, các điểm cũ giữ nguyên vị trí,
// chỉ "thêm" điểm mới. Không có visual shift.
export const generateMegaDatasetProgressive = (
  count: number,
  checkpointAt: number,
  onCheckpoint: (sample: { type: "FeatureCollection"; features: ReturnType<typeof makeFeature>[] }) => void,
) => {
  const features = new Array(count);
  const totalWeight = SEEDS.reduce((sum, s) => sum + s.weight, 0);
  console.time(`generate progressive ${count.toLocaleString()}`);
  for (let i = 0; i < count; i++) {
    features[i] = makeFeature(i, pickSeed(totalWeight));
    if (i === checkpointAt - 1 && count > checkpointAt) {
      onCheckpoint({
        type: "FeatureCollection",
        features: features.slice(0, checkpointAt),
      });
    }
  }
  console.timeEnd(`generate progressive ${count.toLocaleString()}`);
  return { type: "FeatureCollection", features };
};
