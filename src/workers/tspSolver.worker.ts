// ============================================================================
//  TSP Solver Worker — giải bài toán Người bán hàng (Traveling Salesman Problem).
//  CHẠY HOÀN TOÀN TRONG WORKER -> main thread không bị block bởi O(N²)/O(2ⁿ).
//
//  Worker là BỘ GIẢI MA TRẬN THUẦN: main thread nạp sẵn ma trận khoảng cách
//  (mét) — lấy từ OSRM /table (đường thật) hoặc haversine (fallback) — rồi đẩy
//  xuống. Worker không tự biết toạ độ, chỉ làm việc trên chi phí giữa các cặp.
//
//  Ba pha, kết quả pha sau luôn ≤ pha trước:
//
//   Pha 1 — Nearest Neighbor (tham lam, O(N²)):
//     Từ kho, mỗi bước nhảy tới điểm CHƯA THĂM rẻ nhất. Nhanh nhưng thiển cận
//     (~25% trên tối ưu) -> dùng làm điểm khởi đầu.
//
//   Pha 2 — 2-opt (local search, O(N²)/lượt):
//     Gỡ các cạnh chéo nhau (vi phạm bất đẳng thức tam giác) bằng cách đảo đoạn
//     giữa hai cạnh. Lặp tới cực tiểu cục bộ 2-opt (~2-5% trên tối ưu).
//
//   Pha 3 — Held-Karp (quy hoạch động, O(N²·2ⁿ)) khi N ≤ EXACT_MAX:
//     Lời giải TỐI ƯU TUYỆT ĐỐI. dp[mask][j] = chi phí nhỏ nhất xuất phát từ kho,
//     thăm đúng tập điểm `mask`, kết tại j. N=20 vẫn chạy được trong Worker
//     (~84MB, ~1-2s). N>20 thì 2ⁿ bùng nổ -> bỏ qua, lấy kết quả 2-opt.
// ============================================================================

// N=20 -> 2²⁰·20 ≈ 21M ô (Float32 ~84MB). Trên ngưỡng này Held-Karp bất khả thi cả về RAM lẫn thời gian.
const EXACT_MAX = 20;

const post = self.postMessage as (message: unknown) => void;

self.onmessage = (event: MessageEvent) => {
  const { type, payload } = event.data;
  if (type !== "SOLVE_TSP") return;

  const matrix: number[][] = payload.matrix; // chi phí (mét) giữa mọi cặp điểm
  const n: number = payload.n ?? matrix.length;
  const start: number = payload.startIndex ?? 0;

  if (n < 2) {
    post({ type: "SOLVED", order: Array.from({ length: n }, (_, i) => i), nnCost: 0, twoOptCost: 0, exactCost: 0, optimal: true });
    return;
  }

  const D = (a: number, b: number) => matrix[a][b];

  // Độ dài chu trình ĐÓNG (đi hết rồi quay về kho).
  const tourLength = (t: number[]): number => {
    let sum = 0;
    for (let i = 0; i < t.length - 1; i++) sum += D(t[i], t[i + 1]);
    sum += D(t[t.length - 1], t[0]);
    return sum;
  };

  // ===========================================================================
  //  PHA 1: Nearest Neighbor
  // ===========================================================================
  const visited = new Uint8Array(n);
  const nnTour: number[] = new Array(n);
  nnTour[0] = start;
  visited[start] = 1;
  for (let step = 1; step < n; step++) {
    const from = nnTour[step - 1];
    let best = -1;
    let bestD = Infinity;
    for (let j = 0; j < n; j++) {
      if (visited[j]) continue;
      const d = D(from, j);
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    nnTour[step] = best;
    visited[best] = 1;
  }
  const nnCost = tourLength(nnTour);

  // ===========================================================================
  //  PHA 2: 2-opt
  // ===========================================================================
  // Cố định kho ở vị trí 0. Với cặp (i, j), thử ĐẢO đoạn tour[i..j]:
  //   delta = D(a[i-1],a[j]) + D(a[i],a[j+1]) - D(a[i-1],a[i]) - D(a[j],a[j+1])
  //   delta < 0 => ngắn hơn -> reverse. (j+1) % n để 2-opt tối ưu cả cạnh quay về kho.
  const tour = nnTour.slice();
  const EPS = 1e-9;
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < n - 1; i++) {
      const a = tour[i - 1];
      const b = tour[i];
      for (let j = i + 1; j < n; j++) {
        const c = tour[j];
        const d = tour[(j + 1) % n];
        const delta = D(a, c) + D(b, d) - D(a, b) - D(c, d);
        if (delta < -EPS) {
          let lo = i;
          let hi = j;
          while (lo < hi) {
            const tmp = tour[lo];
            tour[lo] = tour[hi];
            tour[hi] = tmp;
            lo++;
            hi--;
          }
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
  }
  const twoOptCost = tourLength(tour);

  // ===========================================================================
  //  PHA 3: Held-Karp (chính xác) — chỉ khi N ≤ EXACT_MAX
  // ===========================================================================
  let exactOrder: number[] | null = null;
  let exactCost: number | null = null;

  if (n <= EXACT_MAX) {
    const full = (1 << n) - 1;
    const size = (1 << n) * n;
    // dp[mask*n + j]: chi phí nhỏ nhất, xuất phát kho, thăm đúng `mask`, kết tại j.
    const dp = new Float32Array(size).fill(Infinity);
    const parent = new Uint8Array(size).fill(255); // 255 = sentinel (chưa có cha)

    dp[(1 << start) * n + start] = 0; // base: chỉ mới ở kho

    for (let mask = 0; mask <= full; mask++) {
      if (!(mask & (1 << start))) continue; // mọi đường đều bắt đầu ở kho
      for (let j = 0; j < n; j++) {
        if (!(mask & (1 << j))) continue;
        const cur = dp[mask * n + j];
        if (cur === Infinity) continue;
        // Mở rộng sang điểm k chưa thăm
        for (let k = 0; k < n; k++) {
          if (mask & (1 << k)) continue;
          const nm = mask | (1 << k);
          const cand = cur + D(j, k);
          if (cand < dp[nm * n + k]) {
            dp[nm * n + k] = cand;
            parent[nm * n + k] = j;
          }
        }
      }
    }

    // Đóng vòng: chọn điểm cuối j tối thiểu dp[full][j] + cạnh về kho.
    let bestEnd = start;
    let best = Infinity;
    for (let j = 0; j < n; j++) {
      if (j === start) continue;
      const total = dp[full * n + j] + D(j, start);
      if (total < best) {
        best = total;
        bestEnd = j;
      }
    }

    // Truy vết cha: từ bestEnd lần ngược tập bit về kho.
    const seq: number[] = [];
    let mask = full;
    let curNode = bestEnd;
    while (curNode !== 255) {
      seq.push(curNode);
      const prev = parent[mask * n + curNode];
      mask &= ~(1 << curNode);
      if (curNode === start) break;
      curNode = prev;
    }
    seq.reverse(); // [start, ..., bestEnd]

    exactOrder = seq;
    exactCost = tourLength(seq);
  }

  // Kết quả tốt nhất hiện có: Held-Karp nếu chạy, ngược lại 2-opt.
  const order = exactOrder ?? tour;
  post({
    type: "SOLVED",
    order,
    nnOrder: nnTour, // thứ tự Nearest Neighbor thuần — main thread vẽ chồng để so sánh
    nnCost,
    twoOptCost,
    exactCost, // null nếu N > EXACT_MAX
    optimal: exactOrder !== null,
  });
};
