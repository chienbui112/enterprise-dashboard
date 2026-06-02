// floodLayers.ts
// Hai lớp render WebGL tuỳ biến (CustomLayerInterface) cắm thẳng vào ngữ cảnh GL của MapLibre:
//
//   1) FloodWaterLayer    — mặt phẳng nước trong suốt, GPU tự dập sóng theo Vertex Shader,
//                           cao độ điều khiển bằng uniform `u_levelZ` (đẩy trực tiếp từ Slider,
//                           KHÔNG đi qua vòng re-render của React).
//   2) InstancedPropsLayer — cây xanh + rào chắn cứu hộ vẽ bằng INSTANCED RENDERING
//                           (drawArraysInstanced): 1 base mesh dùng chung cho hàng nghìn vật thể,
//                           chỉ tốn 1 VBO nhỏ cho thuộc tính theo-instance -> không tràn VRAM.
//
// Cả hai chia sẻ một con trỏ mực nước `WaterRef` (đối tượng mutable) làm nguồn sự thật duy nhất.

import {
  MercatorCoordinate,
  type CustomLayerInterface,
  type CustomRenderMethodInput,
  type Map,
} from "maplibre-gl";
import {
  createProgram,
  buildWaterGrid,
  buildTreeMesh,
  buildBarrierMesh,
  WATER_VERTEX_SRC,
  WATER_FRAGMENT_SRC,
  PROP_VERTEX_SRC,
  PROP_FRAGMENT_SRC,
  SCENE_CENTER,
  FLOOD_VIS_SCALE,
  TREE_STRIDE,
  BARRIER_STRIDE,
  type MeshData,
} from "./floodHelpers";

type GL = WebGLRenderingContext | WebGL2RenderingContext;

// Nguồn sự thật mực nước (m), chia sẻ giữa các layer và Slider. Mutable có chủ đích.
export interface WaterRef {
  meters: number;
}

// Khởi tạo helper instancing đa-context: WebGL2 có sẵn API, WebGL1 mượn extension ANGLE.
const makeInstancing = (gl: GL) => {
  if (typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext) {
    const g2 = gl;
    return {
      ok: true,
      divisor: (loc: number, d: number) => g2.vertexAttribDivisor(loc, d),
      draw: (mode: number, first: number, count: number, instances: number) =>
        g2.drawArraysInstanced(mode, first, count, instances),
    };
  }
  const ext = (gl as WebGLRenderingContext).getExtension("ANGLE_instanced_arrays");
  if (!ext) return { ok: false, divisor: () => {}, draw: () => {} };
  return {
    ok: true,
    divisor: (loc: number, d: number) => ext.vertexAttribDivisorANGLE(loc, d),
    draw: (mode: number, first: number, count: number, instances: number) =>
      ext.drawArraysInstancedANGLE(mode, first, count, instances),
  };
};

// Hệ số mét -> đơn vị Mercator tại một vĩ độ (cao độ conformal trong custom layer 3D).
const meterToMercatorAt = (lng: number, lat: number): number =>
  MercatorCoordinate.fromLngLat([lng, lat], 0).meterInMercatorCoordinateUnits();

// =============================================================================
// LỚP 1 — MẶT NƯỚC ĐỘNG
// =============================================================================

export class FloodWaterLayer implements CustomLayerInterface {
  id: string;
  type = "custom" as const;
  renderingMode = "3d" as const;

  private map: Map | null = null;
  private gl: GL | null = null;
  private program: WebGLProgram | null = null;

  private posBuffer: WebGLBuffer | null = null;
  private indexBuffer: WebGLBuffer | null = null;
  private indexCount = 0;
  private indexType = 0; // gl.UNSIGNED_SHORT | gl.UNSIGNED_INT

  private loc: Record<string, number | WebGLUniformLocation | null> = {};
  private meterToMercator = 1;
  private originX = 0; // tâm mặt nước (mercator) — mốc tính toạ độ mét cho sóng
  private originY = 0;
  private startTime = performance.now();
  private animate: boolean;

  private bbox: [number, number, number, number];
  private waterRef: WaterRef;
  private segments: number;

  constructor(opts: {
    id: string;
    waterRef: WaterRef;
    bbox: [number, number, number, number];
    segments?: number;
    animate?: boolean;
  }) {
    this.id = opts.id;
    this.waterRef = opts.waterRef;
    this.bbox = opts.bbox;
    this.segments = opts.segments ?? 128;
    this.animate = opts.animate ?? true;
  }

  onAdd(map: Map, gl: GL): void {
    this.map = map;
    this.gl = gl;
    this.program = createProgram(gl, WATER_VERTEX_SRC, WATER_FRAGMENT_SRC);

    // --- Sinh lưới + ánh xạ (u,v) -> toạ độ Mercator theo bbox ---
    const grid = buildWaterGrid(this.segments);
    const [minLng, minLat, maxLng, maxLat] = this.bbox;
    const vertCount = grid.cols * grid.rows;
    const positions = new Float32Array(vertCount * 2);
    for (let i = 0; i < vertCount; i++) {
      const u = grid.uv[i * 2];
      const v = grid.uv[i * 2 + 1];
      const lng = minLng + (maxLng - minLng) * u;
      const lat = minLat + (maxLat - minLat) * v;
      const m = MercatorCoordinate.fromLngLat([lng, lat], 0);
      positions[i * 2] = m.x;
      positions[i * 2 + 1] = m.y;
    }
    this.meterToMercator = meterToMercatorAt(SCENE_CENTER[0], SCENE_CENTER[1]);
    // Tâm mặt nước (mercator) = mốc 0 mét cho sóng không gian thật.
    const center = MercatorCoordinate.fromLngLat([(minLng + maxLng) / 2, (minLat + maxLat) / 2], 0);
    this.originX = center.x;
    this.originY = center.y;

    // --- VBO/IBO ---
    this.posBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

    // Chỉ số: dùng Uint16 nếu đủ (tránh phụ thuộc OES_element_index_uint trên WebGL1).
    const isGl2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
    const canUint32 = isGl2 || !!(gl as WebGLRenderingContext).getExtension("OES_element_index_uint");
    let indexData: ArrayBufferView;
    if (vertCount <= 65536) {
      indexData = new Uint16Array(grid.indices);
      this.indexType = gl.UNSIGNED_SHORT;
    } else if (canUint32) {
      indexData = grid.indices;
      this.indexType = gl.UNSIGNED_INT;
    } else {
      throw new Error("Lưới mặt nước quá lớn cho Uint16 và thiếu OES_element_index_uint");
    }
    this.indexCount = grid.indices.length;
    this.indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexData, gl.STATIC_DRAW);

    // --- Cache vị trí attribute/uniform ---
    const p = this.program;
    this.loc = {
      a_pos: gl.getAttribLocation(p, "a_pos"),
      u_matrix: gl.getUniformLocation(p, "u_matrix"),
      u_levelZ: gl.getUniformLocation(p, "u_levelZ"),
      u_origin: gl.getUniformLocation(p, "u_origin"),
      u_meter: gl.getUniformLocation(p, "u_meter"),
      u_time: gl.getUniformLocation(p, "u_time"),
      u_levelMeters: gl.getUniformLocation(p, "u_levelMeters"),
    };
  }

  render(gl: GL, args: CustomRenderMethodInput): void {
    if (!this.program) return;

    // Luôn xin repaint trước (kể cả khi không vẽ) để lúc kéo Slider từ 0 lên, nước hiện
    // ra ngay — Slider mutate ref chứ không re-render React nên cần vòng lặp vẽ vẫn chạy.
    if (this.animate) this.map?.triggerRepaint();

    const meters = this.waterRef.meters;
    // Mức ~0: KHÔNG vẽ mặt nước (sóng dao động quanh z=0 sẽ che mất chân cây/nhà).
    if (meters <= 0.001) return;

    gl.useProgram(this.program);
    // Cao độ HIỂN THỊ = mét thật × hệ số phóng đại trực quan (để nước leo rõ lên vật thể).
    const visMeters = meters * FLOOD_VIS_SCALE;

    // Ma trận đúng cho custom layer toạ độ Mercator trong MapLibre v5 là
    // defaultProjectionData.mainMatrix (KHÔNG phải modelViewProjectionMatrix) — đây chính
    // là ma trận chiếu mercator [0..1] -> clip mà MercatorCoordinate cần.
    gl.uniformMatrix4fv(
      this.loc.u_matrix as WebGLUniformLocation,
      false,
      args.defaultProjectionData.mainMatrix as unknown as Float32Array,
    );
    gl.uniform1f(this.loc.u_levelZ as WebGLUniformLocation, visMeters * this.meterToMercator);
    gl.uniform2f(this.loc.u_origin as WebGLUniformLocation, this.originX, this.originY);
    gl.uniform1f(this.loc.u_meter as WebGLUniformLocation, this.meterToMercator);
    gl.uniform1f(this.loc.u_levelMeters as WebGLUniformLocation, meters);
    gl.uniform1f(this.loc.u_time as WebGLUniformLocation, (performance.now() - this.startTime) / 1000);

    // Nước trong suốt: bật blend, đọc depth của toà nhà/props nhưng KHÔNG ghi depth
    // (để mặt nước không che lẫn nhau và lộ vật thể chìm phía dưới).
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    // QUAN TRỌNG: MapLibre bật CULL_FACE cho layer của nó; mặt phẳng nước nằm ngang nhìn
    // từ trên xuống có thể bị cull (sai chiều winding) -> không hiện. Tắt cull cho mặt nước.
    gl.disable(gl.CULL_FACE);
    // Polygon offset chỉ dùng BIAS HẰNG SỐ (factor = 0). KHÔNG dùng hệ số slope: mặt nước
    // nằm ngang khi nhìn NGHIÊNG có độ dốc depth rất lớn, factor != 0 sẽ tạo offset khổng lồ
    // khiến nước leo đè sai lên tường nhà. units âm = lệch về phía camera đủ để nước THẮNG
    // z-fighting với mặt đất/địa hình ở vùng xa (lũ đồng mức -> phủ kín cả vùng là đúng);
    // tường nhà thẳng đứng nên gần như không bị bias này làm leo lên.
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(0.0, -4.0);

    const aPos = this.loc.a_pos as number;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.drawElements(gl.TRIANGLES, this.indexCount, this.indexType, 0);

    // Trả lại trạng thái mặc định cho MapLibre.
    gl.disableVertexAttribArray(aPos);
    gl.depthMask(true);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(0, 0);
  }

  onRemove(): void {
    const gl = this.gl;
    if (!gl) return;
    if (this.posBuffer) gl.deleteBuffer(this.posBuffer);
    if (this.indexBuffer) gl.deleteBuffer(this.indexBuffer);
    if (this.program) gl.deleteProgram(this.program);
  }
}

// =============================================================================
// LỚP 2 — INSTANCED PROPS (CÂY / RÀO CHẮN)
// =============================================================================

// Một "draw set" = 1 base mesh + 1 VBO thuộc tính theo-instance.
interface DrawSet {
  // base mesh
  posBuf: WebGLBuffer;
  normBuf: WebGLBuffer;
  colBuf: WebGLBuffer;
  vertexCount: number;
  // instance: [merc_x, merc_y, scale, rot] × instanceCount
  instBuf: WebGLBuffer;
  instanceCount: number;
}

export class InstancedPropsLayer implements CustomLayerInterface {
  id: string;
  type = "custom" as const;
  renderingMode = "3d" as const;

  private gl: GL | null = null;
  private program: WebGLProgram | null = null;
  private inst: ReturnType<typeof makeInstancing> = { ok: false, divisor: () => {}, draw: () => {} };

  private trees: DrawSet | null = null;
  private barriers: DrawSet | null = null;

  private loc: Record<string, number | WebGLUniformLocation | null> = {};
  private meterToMercator = 1;
  private waterRef: WaterRef;

  private treeData: Float32Array;
  private barrierData: Float32Array;
  private visible = true; // ẩn khi chuyển sang nền Google 3D Tiles (nhà/cây thật đã có sẵn)

  constructor(opts: { id: string; waterRef: WaterRef; trees: Float32Array; barriers: Float32Array }) {
    this.id = opts.id;
    this.waterRef = opts.waterRef;
    this.treeData = opts.trees;
    this.barrierData = opts.barriers;
  }

  // Bật/tắt vẽ props (FloodWaterLayer luôn triggerRepaint nên đổi cờ là frame sau cập nhật).
  setVisible(v: boolean): void {
    this.visible = v;
  }

  // Dựng base-mesh VBO + instance VBO cho 1 loại prop.
  private buildSet(gl: GL, mesh: MeshData, data: Float32Array, stride: number): DrawSet {
    const instanceCount = data.length / stride;
    // Chuyển [lng, lat, scale, rot] -> [merc_x, merc_y, scale, rot].
    const inst = new Float32Array(instanceCount * 4);
    for (let i = 0; i < instanceCount; i++) {
      const o = i * stride;
      const m = MercatorCoordinate.fromLngLat([data[o], data[o + 1]], 0);
      inst[i * 4] = m.x;
      inst[i * 4 + 1] = m.y;
      inst[i * 4 + 2] = data[o + 2];
      inst[i * 4 + 3] = data[o + 3];
    }

    const mkBuf = (src: Float32Array): WebGLBuffer => {
      const b = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, src, gl.STATIC_DRAW);
      return b;
    };

    return {
      posBuf: mkBuf(mesh.positions),
      normBuf: mkBuf(mesh.normals),
      colBuf: mkBuf(mesh.colors),
      vertexCount: mesh.vertexCount,
      instBuf: mkBuf(inst),
      instanceCount,
    };
  }

  onAdd(_map: Map, gl: GL): void {
    this.gl = gl;
    this.inst = makeInstancing(gl);
    this.program = createProgram(gl, PROP_VERTEX_SRC, PROP_FRAGMENT_SRC);
    this.meterToMercator = meterToMercatorAt(SCENE_CENTER[0], SCENE_CENTER[1]);

    if (this.treeData.length) this.trees = this.buildSet(gl, buildTreeMesh(), this.treeData, TREE_STRIDE);
    if (this.barrierData.length)
      this.barriers = this.buildSet(gl, buildBarrierMesh(), this.barrierData, BARRIER_STRIDE);

    const p = this.program;
    this.loc = {
      a_model: gl.getAttribLocation(p, "a_model"),
      a_normal: gl.getAttribLocation(p, "a_normal"),
      a_color: gl.getAttribLocation(p, "a_color"),
      a_offset: gl.getAttribLocation(p, "a_offset"),
      a_scale: gl.getAttribLocation(p, "a_scale"),
      a_rot: gl.getAttribLocation(p, "a_rot"),
      u_matrix: gl.getUniformLocation(p, "u_matrix"),
      u_meter: gl.getUniformLocation(p, "u_meter"),
      u_waterMeters: gl.getUniformLocation(p, "u_waterMeters"),
    };
  }

  private drawSet(gl: GL, set: DrawSet): void {
    const aModel = this.loc.a_model as number;
    const aNormal = this.loc.a_normal as number;
    const aColor = this.loc.a_color as number;
    const aOffset = this.loc.a_offset as number;
    const aScale = this.loc.a_scale as number;
    const aRot = this.loc.a_rot as number;

    // Base mesh (divisor 0).
    gl.bindBuffer(gl.ARRAY_BUFFER, set.posBuf);
    gl.enableVertexAttribArray(aModel);
    gl.vertexAttribPointer(aModel, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, set.normBuf);
    gl.enableVertexAttribArray(aNormal);
    gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, set.colBuf);
    gl.enableVertexAttribArray(aColor);
    gl.vertexAttribPointer(aColor, 3, gl.FLOAT, false, 0, 0);

    // Thuộc tính theo-instance (divisor 1): offset(vec2), scale(float), rot(float).
    const STRIDE = 4 * 4; // 4 float
    gl.bindBuffer(gl.ARRAY_BUFFER, set.instBuf);
    gl.enableVertexAttribArray(aOffset);
    gl.vertexAttribPointer(aOffset, 2, gl.FLOAT, false, STRIDE, 0);
    this.inst.divisor(aOffset, 1);
    gl.enableVertexAttribArray(aScale);
    gl.vertexAttribPointer(aScale, 1, gl.FLOAT, false, STRIDE, 2 * 4);
    this.inst.divisor(aScale, 1);
    gl.enableVertexAttribArray(aRot);
    gl.vertexAttribPointer(aRot, 1, gl.FLOAT, false, STRIDE, 3 * 4);
    this.inst.divisor(aRot, 1);

    this.inst.draw(gl.TRIANGLES, 0, set.vertexCount, set.instanceCount);

    // Dọn dẹp: reset divisor + tắt array để không làm hỏng state của MapLibre.
    this.inst.divisor(aOffset, 0);
    this.inst.divisor(aScale, 0);
    this.inst.divisor(aRot, 0);
    gl.disableVertexAttribArray(aModel);
    gl.disableVertexAttribArray(aNormal);
    gl.disableVertexAttribArray(aColor);
    gl.disableVertexAttribArray(aOffset);
    gl.disableVertexAttribArray(aScale);
    gl.disableVertexAttribArray(aRot);
  }

  render(gl: GL, args: CustomRenderMethodInput): void {
    if (!this.program || !this.inst.ok || !this.visible) return;
    gl.useProgram(this.program);

    gl.uniformMatrix4fv(
      this.loc.u_matrix as WebGLUniformLocation,
      false,
      args.defaultProjectionData.mainMatrix as unknown as Float32Array,
    );
    gl.uniform1f(this.loc.u_meter as WebGLUniformLocation, this.meterToMercator);
    // So mốc chìm cũng dùng cao độ HIỂN THỊ -> khớp với mặt phẳng nước đã phóng đại.
    gl.uniform1f(this.loc.u_waterMeters as WebGLUniformLocation, this.waterRef.meters * FLOOD_VIS_SCALE);

    // Props là vật thể đặc: bật depth test + ghi depth, tắt blend.
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    // Tắt cull để nón/hộp hiện đủ mặt bất kể chiều winding (an toàn hơn cho geometry tự sinh).
    gl.disable(gl.CULL_FACE);

    if (this.trees) this.drawSet(gl, this.trees);
    if (this.barriers) this.drawSet(gl, this.barriers);
  }

  onRemove(): void {
    const gl = this.gl;
    if (!gl) return;
    const free = (s: DrawSet | null) => {
      if (!s) return;
      gl.deleteBuffer(s.posBuf);
      gl.deleteBuffer(s.normBuf);
      gl.deleteBuffer(s.colBuf);
      gl.deleteBuffer(s.instBuf);
    };
    free(this.trees);
    free(this.barriers);
    if (this.program) gl.deleteProgram(this.program);
  }
}
