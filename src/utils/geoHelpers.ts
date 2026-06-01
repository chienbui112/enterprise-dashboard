export const STATUSES = ["active", "busy", "offline"] as const;
export type DriverStatus = (typeof STATUSES)[number];

// Tốc độ trung bình giả định cho giao hàng nội đô (km/h) — dùng để ước tính ETA
export const AVG_SPEED_KMH = 25;

export interface DriverProperties {
  // Lưu chỉ số (index) thay vì chuỗi id/name: số nguyên không cấp phát bộ nhớ mỗi tick.
  // id/name chỉ là dữ liệu suy ra, dựng khi cần (vd: popup) qua driverId()/driverName().
  idx: number;
  status: DriverStatus;
  bearing: number; // hướng di chuyển (độ, 0 = Bắc, theo chiều kim đồng hồ)
}

export interface DriverFeature {
  type: "Feature";
  geometry: {
    type: "Point";
    coordinates: [number, number]; // [lng, lat]
  };
  properties: DriverProperties;
}

// id/name suy ra từ index — chỉ gọi khi thực sự cần hiển thị, tránh tạo 100k chuỗi mỗi 5s
export const driverId = (idx: number): string => `driver-${idx}`;
export const driverName = (idx: number): string => `Driver No.${idx + 1}`;

export interface DriversSoA {
  lngs: Float64Array;
  lats: Float64Array;
  bearings: Float64Array;
  statuses: Uint8Array; // index vào STATUSES
  destLngs: Float64Array; // điểm đến (tĩnh)
  destLats: Float64Array;
}

// Sinh dữ liệu giả lập dạng Struct-of-Arrays quanh Hà Nội.
// Dùng typed array để: (1) bộ nhớ liên tục, (2) mutate tại chỗ khi stream, (3) Transfer zero-copy.
export const generateDriversSoA = (count: number): DriversSoA => {
  const lngs = new Float64Array(count);
  const lats = new Float64Array(count);
  const bearings = new Float64Array(count);
  const statuses = new Uint8Array(count);
  const destLngs = new Float64Array(count);
  const destLats = new Float64Array(count);

  for (let i = 0; i < count; i++) {
    lngs[i] = 105.75 + Math.random() * 0.18;
    lats[i] = 20.95 + Math.random() * 0.15;
    bearings[i] = Math.random() * 360;
    statuses[i] = Math.floor(Math.random() * STATUSES.length);
    destLngs[i] = 105.75 + Math.random() * 0.18;
    destLats[i] = 20.95 + Math.random() * 0.15;
  }

  return { lngs, lats, bearings, statuses, destLngs, destLats };
};

// Sinh dữ liệu giả lập dạng GeoJSON Features (dùng cho dashboard không qua worker).
// Khác với generateDriversSoA (typed array, zero-copy): trả về mảng Feature object để
// tương thích trực tiếp với MapLibre/Turf. Đánh đổi cấp phát bộ nhớ lấy sự đơn giản —
// phù hợp cho dataset cỡ vài nghìn điểm.
export const generateDriverFeatures = (count: number): DriverFeature[] => {
  const features: DriverFeature[] = new Array(count);
  for (let i = 0; i < count; i++) {
    features[i] = {
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [105.75 + Math.random() * 0.18, 20.95 + Math.random() * 0.15],
      },
      properties: {
        idx: i,
        status: STATUSES[Math.floor(Math.random() * STATUSES.length)],
        bearing: Math.random() * 360,
      },
    };
  }
  return features;
};

// Khoảng cách great-circle (km) giữa hai điểm [lng, lat]
export const haversineKm = (lng1: number, lat1: number, lng2: number, lat2: number): number => {
  const R = 6371;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// Góc phương vị (độ, 0 = Bắc, theo chiều kim đồng hồ) từ điểm hiện tại tới điểm đích
export const bearingDeg = (lng1: number, lat1: number, lng2: number, lat2: number): number => {
  const dx = (lng2 - lng1) * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  const dy = lat2 - lat1;
  return (Math.atan2(dx, dy) * (180 / Math.PI) + 360) % 360;
};
