// floodHelpers.ts
// Toàn bộ "đồ nghề" WebGL cấp thấp cho dashboard Digital Twin ngập lụt:
//   - Mã GLSL (Vertex + Fragment) cho mặt nước động và cho lớp render Instanced (cây / rào chắn).
//   - Trình tiện ích biên dịch shader + link program.
//   - Bộ sinh hình học (lưới mặt nước, hình nón, hình hộp) ở KHÔNG GIAN MÉT cục bộ.
//   - Kiểu dữ liệu mô tả cảnh (scene) trao đổi với worker.
//
// Triết lý: shader nhận toạ độ ở dạng Web Mercator (0..1) do MapLibre cấp ma trận
// modelViewProjectionMatrix; cao độ (trục z) là "conformal" — 1 đơn vị mét quy đổi sang
// mercator qua MercatorCoordinate.meterInMercatorCoordinateUnits(). Vì vậy mọi hình học
// dựng ở đơn vị MÉT rồi nhân hệ số u_meter trong shader -> đúng tỉ lệ thật.

// =============================================================================
// 1. KIỂU DỮ LIỆU CẢNH (SCENE)
// =============================================================================

export interface FloodBuildingProps {
  id: string;
  height: number; // cao độ đỉnh (m)
  min_height: number; // cao độ chân khối (m) — phần lớn = 0
  base_color: string;
}

export interface FloodBuildingFeature {
  type: "Feature";
  geometry: { type: "Polygon"; coordinates: [number, number][][] };
  properties: FloodBuildingProps;
}

export interface FloodBuildingCollection {
  type: "FeatureCollection";
  features: FloodBuildingFeature[];
}

// Tâm cảnh mặc định: khu vực trung tâm Hà Nội (theo convention của dự án).
export const SCENE_CENTER: [number, number] = [105.83, 21.02];
// Bán kính (độ) vùng mô phỏng — cụm toà nhà giả lập gói gọn trong đây.
export const SCENE_HALF_DEG = 0.02;
// Mặt nước phủ RỘNG hơn nhiều (~27km nửa cạnh) để luôn kín tầm nhìn ở mọi mức zoom đô thị
// (không lộ mép tấm nước khi zoom ra). Tấm phẳng nên chi phí hình học không đáng kể.
export const SCENE_HALF_DEG_WATER = 0.25;

// Hệ số PHÓNG ĐẠI TRỰC QUAN theo chiều cao: nhân cao độ nước (và mốc so chìm của props)
// lên FLOOD_VIS_SCALE lần để mực nước leo rõ lên chân nhà / cây / rào khi kéo Slider.
// Slider vẫn hiển thị số MÉT THẬT; đây thuần tuý là phóng đại hiển thị. Với dải 0–20m,
// ×4 là vừa: lũ tối đa (20m → ~80m hiển thị) nhấn chìm phần lớn nhà nhưng các toà cao
// nhất vẫn nhô lên (hiệu ứng kịch tính hơn so với chìm sạch).
export const FLOOD_VIS_SCALE = 4;

// Layout mảng instance phẳng cho props (tránh structured-clone object nặng).
// Mỗi cây:   [lng, lat, heightMeters, rotationRad]   -> TREE_STRIDE floats
// Mỗi rào:   [lng, lat, scale,         rotationRad]   -> BARRIER_STRIDE floats
export const TREE_STRIDE = 4;
export const BARRIER_STRIDE = 4;

// =============================================================================
// 2. MÃ GLSL — MẶT NƯỚC ĐỘNG
// =============================================================================
// GLSL ES 1.00 (không khai báo #version) để chạy được trên cả WebGL1 lẫn WebGL2
// context mà MapLibre tạo ra.

export const WATER_VERTEX_SRC = /* glsl */ `
precision highp float;

attribute vec2 a_pos;    // toạ độ Web Mercator (x, y) của đỉnh lưới

uniform mat4  u_matrix;  // ma trận chiếu mercator -> clip (defaultProjectionData.mainMatrix)
uniform float u_levelZ;  // cao độ mặt nước quy ra ĐƠN VỊ MERCATOR
uniform vec2  u_origin;  // tâm mặt nước (mercator) -> mốc tính toạ độ mét
uniform float u_meter;   // hệ số mét -> mercator

varying vec2 v_local;    // toạ độ MÉT so với tâm: sóng theo KHÔNG GIAN THẬT (bất biến theo zoom)

void main() {
  // Mặt nước PHẲNG TUYỆT ĐỐI ở đúng cao độ u_levelZ: mọi đỉnh cùng z -> mép nước cắt
  // ngang đều trên tất cả toà nhà. Sóng mô phỏng trong Fragment Shader theo toạ độ mét.
  v_local = (a_pos - u_origin) / u_meter;
  gl_Position = u_matrix * vec4(a_pos, u_levelZ, 1.0);
}
`;

export const WATER_FRAGMENT_SRC = /* glsl */ `
precision highp float;

varying vec2 v_local; // mét so với tâm mặt nước

uniform float u_time;
uniform float u_levelMeters; // mực nước (m) -> càng cao càng đục/đậm

void main() {
  // Sóng mô phỏng HOÀN TOÀN bằng MÀU theo toạ độ MÉT (bước sóng cố định ~chục mét, không
  // đổi theo zoom). Bề mặt vẫn phẳng tuyệt đối nên mép nước trên toà nhà luôn ngang đều.
  float w =
      sin(v_local.x * 0.10 + u_time * 1.6) * 0.5
    + cos(v_local.y * 0.13 - u_time * 1.2) * 0.5
    + sin((v_local.x + v_local.y) * 0.07 + u_time * 2.1) * 0.35;
  float crest = clamp(w * 0.5 + 0.5, 0.0, 1.0);

  // Pha trộn màu nước sâu <-> nông theo "đỉnh sóng giả". Màu XANH (cyan) sáng để nổi bật.
  vec3 deep    = vec3(0.05, 0.40, 0.62);
  vec3 shallow = vec3(0.32, 0.74, 0.92);
  vec3 col     = mix(deep, shallow, crest);

  // Vệt phản quang chạy động (bước sóng ~14m) tạo lấp lánh mặt nước.
  float ripple = sin(v_local.x * 0.45 + u_time * 3.0) * sin(v_local.y * 0.45 - u_time * 2.2);
  col += vec3(0.18) * smoothstep(0.6, 1.0, ripple);

  // Nước dâng cao -> xanh đục hơn (mô phỏng phù sa lũ).
  float muddy = clamp(u_levelMeters / 5.0, 0.0, 1.0);
  col = mix(col, vec3(0.10, 0.30, 0.40), muddy * 0.3);

  float alpha = 0.72 + 0.14 * crest;
  gl_FragColor = vec4(col, alpha);
}
`;

// =============================================================================
// 3. MÃ GLSL — INSTANCED RENDERING (CÂY / RÀO CHẮN CỨU HỘ)
// =============================================================================
// Mỗi vật thể chia sẻ chung 1 base mesh (a_model/a_normal/a_color), chỉ khác
// nhau ở thuộc tính theo-instance: vị trí mercator, scale (m), góc quay.

export const PROP_VERTEX_SRC = /* glsl */ `
precision highp float;

// Thuộc tính theo ĐỈNH của base mesh (model space, đơn vị mét).
attribute vec3 a_model;
attribute vec3 a_normal;
attribute vec3 a_color;

// Thuộc tính theo INSTANCE (divisor = 1).
attribute vec2 a_offset; // vị trí mercator (x, y) của instance
attribute float a_scale; // tỉ lệ phóng (mét)
attribute float a_rot;   // góc quay quanh trục đứng (rad)

uniform mat4  u_matrix;
uniform float u_meter;        // mét -> mercator
uniform float u_waterMeters;  // mực nước hiện tại (m) -> nhuộm phần chìm

varying vec3  v_color;
varying vec3  v_normal;
varying float v_zMeters;      // cao độ đỉnh (m) để so với mực nước trong fragment

void main() {
  vec3 m = a_model * a_scale;                 // phóng to model theo mét

  // Xoay quanh trục đứng (z).
  float c = cos(a_rot), s = sin(a_rot);
  vec2 rotXY = vec2(m.x * c - m.y * s, m.x * s + m.y * c);

  vec2 worldXY = a_offset + rotXY * u_meter;  // dời tới vị trí instance (mercator)
  float zMerc  = m.z * u_meter;

  v_color   = a_color;
  // Xoay normal theo cùng phép quay để chiếu sáng đúng.
  v_normal  = normalize(vec3(a_normal.x * c - a_normal.y * s, a_normal.x * s + a_normal.y * c, a_normal.z));
  v_zMeters = m.z;

  gl_Position = u_matrix * vec4(worldXY, zMerc, 1.0);
}
`;

export const PROP_FRAGMENT_SRC = /* glsl */ `
precision highp float;

varying vec3  v_color;
varying vec3  v_normal;
varying float v_zMeters;

uniform float u_waterMeters;

void main() {
  // Chiếu sáng Lambert đơn giản với 1 nguồn sáng cố định.
  vec3 lightDir = normalize(vec3(0.4, 0.6, 0.8));
  float diff = max(dot(normalize(v_normal), lightDir), 0.0);
  vec3 col = v_color * (0.45 + 0.55 * diff);

  // Phần vật thể nằm DƯỚI mực nước bị nhuộm xanh + tối đi (chìm trong lũ, khớp màu nước).
  if (v_zMeters < u_waterMeters) {
    col = mix(col, vec3(0.06, 0.24, 0.42), 0.6);
  }

  gl_FragColor = vec4(col, 1.0);
}
`;

// =============================================================================
// 4. TIỆN ÍCH BIÊN DỊCH SHADER / LINK PROGRAM
// =============================================================================

type GL = WebGLRenderingContext | WebGL2RenderingContext;

const compileShader = (gl: GL, type: number, src: string): WebGLShader => {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Không tạo được WebGLShader");
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Lỗi biên dịch shader:\n${log}\n---\n${src}`);
  }
  return shader;
};

export const createProgram = (gl: GL, vertexSrc: string, fragmentSrc: string): WebGLProgram => {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSrc);
  const program = gl.createProgram();
  if (!program) throw new Error("Không tạo được WebGLProgram");
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  // Shader object có thể xoá sau khi link (program đã giữ bản sao).
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Lỗi link program:\n${log}`);
  }
  return program;
};

// =============================================================================
// 5. BỘ SINH HÌNH HỌC (KHÔNG GIAN MÉT CỤC BỘ)
// =============================================================================

export interface MeshData {
  positions: Float32Array; // x,y,z (mét) — non-indexed (drawArrays)
  normals: Float32Array; // x,y,z
  colors: Float32Array; // r,g,b [0..1]
  vertexCount: number;
}

// --- Lưới mặt nước phẳng trong vùng bbox (toạ độ Mercator được tính ở layer) ---
// Trả về chỉ số lưới để layer tự ánh xạ sang mercator. Ở đây sinh (u,v) + index.
export interface WaterGrid {
  // (u, v) trong [0..1] cho từng đỉnh — layer nội suy ra mercator theo bbox.
  uv: Float32Array;
  indices: Uint32Array;
  cols: number;
  rows: number;
}

export const buildWaterGrid = (segments: number): WaterGrid => {
  const cols = segments + 1;
  const rows = segments + 1;
  const uv = new Float32Array(cols * rows * 2);
  let p = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      uv[p++] = x / segments; // u
      uv[p++] = y / segments; // v
    }
  }
  // 2 tam giác mỗi ô lưới.
  const indices = new Uint32Array(segments * segments * 6);
  let q = 0;
  for (let y = 0; y < segments; y++) {
    for (let x = 0; x < segments; x++) {
      const i0 = y * cols + x;
      const i1 = i0 + 1;
      const i2 = i0 + cols;
      const i3 = i2 + 1;
      indices[q++] = i0;
      indices[q++] = i2;
      indices[q++] = i1;
      indices[q++] = i1;
      indices[q++] = i2;
      indices[q++] = i3;
    }
  }
  return { uv, indices, cols, rows };
};

// Helper gom 3 mảng mesh.
const concatMesh = (parts: MeshData[]): MeshData => {
  const total = parts.reduce((n, m) => n + m.vertexCount, 0);
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const colors = new Float32Array(total * 3);
  let off = 0;
  for (const m of parts) {
    positions.set(m.positions, off * 3);
    normals.set(m.normals, off * 3);
    colors.set(m.colors, off * 3);
    off += m.vertexCount;
  }
  return { positions, normals, colors, vertexCount: total };
};

// --- Hình nón đứng (đỉnh ở trên), z từ z0..z1, bán kính base r (mét) ---
const makeCone = (
  segments: number,
  r: number,
  z0: number,
  z1: number,
  color: [number, number, number],
): MeshData => {
  const tris = segments; // chỉ mặt bên (đáy bị che bởi thân/đất)
  const positions = new Float32Array(tris * 3 * 3);
  const normals = new Float32Array(tris * 3 * 3);
  const colors = new Float32Array(tris * 3 * 3);
  let p = 0;
  const apex: [number, number, number] = [0, 0, z1];
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const b0: [number, number, number] = [Math.cos(a0) * r, Math.sin(a0) * r, z0];
    const b1: [number, number, number] = [Math.cos(a1) * r, Math.sin(a1) * r, z0];
    // Normal xấp xỉ hướng ra ngoài tại trung điểm cạnh đáy.
    const nx = Math.cos((a0 + a1) / 2);
    const ny = Math.sin((a0 + a1) / 2);
    const verts = [apex, b0, b1];
    for (const v of verts) {
      positions[p] = v[0];
      positions[p + 1] = v[1];
      positions[p + 2] = v[2];
      normals[p] = nx * 0.7;
      normals[p + 1] = ny * 0.7;
      normals[p + 2] = 0.5; // hơi nghiêng lên cho sườn nón
      colors[p] = color[0];
      colors[p + 1] = color[1];
      colors[p + 2] = color[2];
      p += 3;
    }
  }
  return { positions, normals, colors, vertexCount: tris * 3 };
};

// --- Hộp chữ nhật tâm gốc, kích thước (sx, sy, sz) mét, đáy ở z=0 ---
const makeBox = (
  sx: number,
  sy: number,
  sz: number,
  color: [number, number, number],
): MeshData => {
  const hx = sx / 2;
  const hy = sy / 2;
  // 8 đỉnh, đáy z=0, đỉnh z=sz.
  const v = [
    [-hx, -hy, 0],
    [hx, -hy, 0],
    [hx, hy, 0],
    [-hx, hy, 0],
    [-hx, -hy, sz],
    [hx, -hy, sz],
    [hx, hy, sz],
    [-hx, hy, sz],
  ];
  // 6 mặt × 2 tam giác, kèm normal mặt.
  const faces: { idx: [number, number, number, number]; n: [number, number, number] }[] = [
    { idx: [4, 5, 6, 7], n: [0, 0, 1] }, // top
    { idx: [0, 3, 2, 1], n: [0, 0, -1] }, // bottom
    { idx: [0, 1, 5, 4], n: [0, -1, 0] }, // -y
    { idx: [2, 3, 7, 6], n: [0, 1, 0] }, // +y
    { idx: [1, 2, 6, 5], n: [1, 0, 0] }, // +x
    { idx: [3, 0, 4, 7], n: [-1, 0, 0] }, // -x
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  for (const f of faces) {
    const [a, b, c, d] = f.idx;
    const quad = [a, b, c, a, c, d];
    for (const vi of quad) {
      positions.push(v[vi][0], v[vi][1], v[vi][2]);
      normals.push(f.n[0], f.n[1], f.n[2]);
      colors.push(color[0], color[1], color[2]);
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    vertexCount: positions.length / 3,
  };
};

// --- Base mesh CÂY (unit height = 1m, scale instance = chiều cao thật) ---
// Thân nâu (hộp mảnh) + tán lá xanh (2 nón chồng) — tất cả trong [0..1] theo z.
export const buildTreeMesh = (): MeshData => {
  const trunk = makeBox(0.08, 0.08, 0.32, [0.45, 0.29, 0.15]);
  const canopyLow = makeCone(8, 0.26, 0.22, 0.7, [0.22, 0.72, 0.30]);
  const canopyTop = makeCone(8, 0.18, 0.55, 1.0, [0.35, 0.88, 0.40]);
  return concatMesh([trunk, canopyLow, canopyTop]);
};

// --- Base mesh RÀO CHẮN CỨU HỘ (unit = scale 1 ~ 1 đơn vị) ---
// Khối hộp dài cam + dải phản quang trắng phía trên.
export const buildBarrierMesh = (): MeshData => {
  const body = makeBox(4.0, 0.4, 1.0, [0.95, 0.45, 0.05]);
  // Dải trắng mỏng đặt sát đỉnh thân.
  const stripe = makeBox(4.02, 0.42, 0.18, [0.95, 0.95, 0.95]);
  // Nâng dải trắng lên cao ~0.8m bằng cách dịch z của positions.
  for (let i = 2; i < stripe.positions.length; i += 3) stripe.positions[i] += 0.8;
  return concatMesh([body, stripe]);
};

// --- Chuyển chuỗi hex "#rrggbb" -> [r,g,b] trong [0..1] ---
export const hexToRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
