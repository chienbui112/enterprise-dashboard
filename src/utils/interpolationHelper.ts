// Hàm tính toán điểm nằm giữa 2 tọa độ dựa trên tỷ lệ % (ratio từ 0 đến 1)
export const lerpCoordinate = (start: [number, number], end: [number, number], ratio: number): [number, number] => {
  const lng = start[0] + (end[0] - start[0]) * ratio;
  const lat = start[1] + (end[1] - start[1]) * ratio;
  return [lng, lat];
};

// Hàm tính góc quay đầu (bearing) giữa 2 điểm để xoay icon xe đúng hướng đường đi
export const computeBearing = (start: [number, number], end: [number, number]): number => {
  const [lng1, lat1] = start.map((v) => (v * Math.PI) / 180);
  const [lng2, lat2] = end.map((v) => (v * Math.PI) / 180);

  const dLng = lng2 - lng1;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);

  const brng = Math.atan2(y, x);
  return ((brng * 180) / Math.PI + 360) % 360;
};
