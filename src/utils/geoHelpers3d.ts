export interface BuildingProperties {
  id: string;
  name: string;
  height: number;
  floors: number;
  base_color: string;
}

export interface BuildingFeature {
  type: "Feature";
  geometry: {
    type: "Polygon";
    coordinates: [[[number, number], [number, number], [number, number], [number, number], [number, number]]];
  };
  properties: BuildingProperties;
}

export interface BuildingFeatureCollection {
  type: "FeatureCollection";
  features: BuildingFeature[];
}

// Hàm giả lập tạo ra một chuỗi JSON khổng lồ chứa hàng chục nghìn tòa nhà 3D để test hiệu năng
export const generateLargeBuildingJsonString = (count: number): string => {
  const features: BuildingFeature[] = [];
  const colors = ["#38bdf8", "#f59e0b", "#ef4444", "#10b981", "#a855f7"];

  // Tọa độ gốc Hà Nội
  const baseLng = 105.8;
  const baseLat = 21.0;

  for (let i = 0; i < count; i++) {
    // Phân bổ ngẫu nhiên trong phạm vi đô thị
    const lng = baseLng + (Math.random() - 0.5) * 0.05;
    const lat = baseLat + (Math.random() - 0.5) * 0.05;

    // Kích thước tòa nhà (~50m)
    const size = 0.0005;
    const floors = Math.floor(Math.random() * 30) + 2; // Từ 2 đến 32 tầng
    const height = floors * 3.5; // Trung bình 3.5m một tầng

    features.push({
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [lng, lat],
            [lng + size, lat],
            [lng + size, lat + size],
            [lng, lat + size],
            [lng, lat], // Khép góc Polygon
          ],
        ],
      },
      properties: {
        id: `bldg-${i}`,
        name: `Building Block ${i + 1}`,
        height: height,
        floors: floors,
        base_color: colors[Math.floor(Math.random() * colors.length)],
      },
    });
  }

  // Trả về dạng CHUỖI STRING để ép Web Worker phải parse, mô phỏng data nặng tải từ API về
  return JSON.stringify({
    type: "FeatureCollection",
    features: features,
  });
};
