import type { Machine, Impl } from "./machine";
import { u32 } from "./user32";

/** Per-vertex floats sent to the backend. */
export const VF = 15;
export const V_X = 0, V_Y = 1, V_Z = 2, V_OOW = 3, V_R = 4, V_G = 5, V_B = 6, V_A = 7;
export const V_S0 = 8, V_T0 = 9, V_Q0 = 10, V_S1 = 11, V_T1 = 12, V_Q1 = 13, V_FOG = 14;

export interface TexDesc {
  /** TMU address of the largest mip level present. */
  addr: number;
  smallLod: number;
  largeLod: number;
  aspect: number;
  format: number;
}

export interface GlideState {
  colorCombine: number[];
  alphaCombine: number[];
  texCombine: number[];
  constantColor: number;
  blend: number[];
  alphaTestFunc: number;
  alphaRef: number;
  depthMode: number;
  depthFunc: number;
  depthMask: boolean;
  depthBias: number;
  colorMask: boolean;
  alphaMask: boolean;
  chromaMode: number;
  chromaValue: number;
  fogMode: number;
  fogColor: number;
  fogTable: Uint8Array;
  cull: number;
  clampS: number;
  clampT: number;
  minFilter: number;
  magFilter: number;
  mipMode: number;
  lodBias: number;
  tex: TexDesc | null;
  texVersion: number;
  clip: [number, number, number, number];
  enables: Set<number>;
  version: number;
}

export interface GlideBackend {
  open(width: number, height: number): void;
  close(): void;
  clear(color: number, alpha: number, depth: number, st: GlideState): void;
  swap(interval: number): void;
  draw(mode: "tri" | "line" | "point", verts: Float32Array, count: number, st: GlideState): void;
  /** Texture memory changed in [addr, addr+len). */
  texWritten(addr: number, len: number): void;
  paletteChanged(pal: Uint32Array, ncc: boolean): void;
  /** 16-bit RGB565 pixels written to the front/back buffer via LFB. */
  lfbWrite(buffer: number, x: number, y: number, w: number, h: number, pixels: Uint16Array | Uint32Array, fmt: number): void;
  lfbRead(buffer: number, w: number, h: number): Uint16Array;
}

export class NullBackend implements GlideBackend {
  frames = 0;
  tris = 0;
  open(): void {}
  close(): void {}
  clear(): void {}
  swap(): void {
    this.frames++;
  }
  draw(mode: string, _v: Float32Array, count: number): void {
    if (mode === "tri") this.tris += count / 3;
  }
  texWritten(): void {}
  paletteChanged(): void {}
  lfbWrite(): void {}
  lfbRead(_b: number, w: number, h: number): Uint16Array {
    return new Uint16Array(w * h);
  }
}

export const TMU_MEM = 8 << 20;

/** Fill value for write-locked LFB memory; pixels still holding it were not written by the game. */
export const LFB_UNTOUCHED16 = 0xf81f;
export const LFB_UNTOUCHED32 = 0x01fe01fe;

export class Glide {
  backend: GlideBackend = new NullBackend();
  width = 640;
  height = 480;
  open = false;
  colorFormat = 0;
  outWidth = 0;
  tmu = new Uint8Array(TMU_MEM);
  palette = new Uint32Array(256);
  layout = new Map<number, number>();
  coordSpace = 0;
  batch = new Float32Array(VF * 4096);
  lfbBuf = 0;
  lfbLock: { buffer: number; write: boolean; fmt: number } | null = null;
  stats = { swaps: 0, tris: 0 };
  st: GlideState = {
    colorCombine: [1, 0, 1, 0, 0], alphaCombine: [1, 0, 1, 0, 0], texCombine: [1, 0, 1, 0, 0, 0],
    constantColor: 0xffffffff, blend: [1, 0, 1, 0], alphaTestFunc: 7, alphaRef: 0, depthMode: 0, depthFunc: 1,
    depthMask: false, depthBias: 0, colorMask: true, alphaMask: false, chromaMode: 0, chromaValue: 0, fogMode: 0,
    fogColor: 0, fogTable: new Uint8Array(64), cull: 0, clampS: 0, clampT: 0, minFilter: 1, magFilter: 1, mipMode: 0,
    lodBias: 0, tex: null, texVersion: 0, clip: [0, 0, 640, 480], enables: new Set(), version: 0,
  };
}

export function glide(m: Machine): Glide {
  return (m.sub.glide ??= new Glide());
}

/** Converts a GrColor_t in the format chosen at grSstWinOpen to 0xAARRGGBB. */
export function toArgb(colorFormat: number, v: number): number {
  const b0 = v >>> 24, b1 = (v >>> 16) & 0xff, b2 = (v >>> 8) & 0xff, b3 = v & 0xff;
  switch (colorFormat) {
    case 1: return ((b0 << 24) | (b3 << 16) | (b2 << 8) | b1) >>> 0;
    case 2: return ((b3 << 24) | (b0 << 16) | (b1 << 8) | b2) >>> 0;
    case 3: return ((b3 << 24) | (b2 << 16) | (b1 << 8) | b0) >>> 0;
    default: return v >>> 0;
  }
}

const argb = (m: Machine, v: number) => toArgb(glide(m).colorFormat, v);

const RES: Record<number, [number, number]> = {
  0x0: [320, 200], 0x1: [320, 240], 0x2: [400, 256], 0x3: [512, 384], 0x4: [640, 200], 0x5: [640, 350], 0x6: [640, 400],
  0x7: [640, 480], 0x8: [800, 600], 0x9: [960, 720], 0xa: [856, 480], 0xb: [512, 256], 0xc: [1024, 768], 0xd: [1280, 1024],
  0xe: [1600, 1200], 0xf: [400, 300], 0x10: [1152, 864], 0x11: [1280, 960], 0x12: [1600, 1024], 0x13: [1792, 1344],
  0x14: [1856, 1392], 0x15: [1920, 1440], 0x16: [2048, 1536], 0x17: [2048, 2048],
};

/** Bytes per texel for a Glide texture format. */
export function texelBytes(fmt: number): number {
  return fmt >= 0x8 && fmt <= 0xe ? 2 : fmt === 0x12 ? 4 : 1;
}

/** Dimensions of mip level `lod` (log2 of the long side) for an aspect ratio log2. */
export function lodDims(lod: number, aspect: number): [number, number] {
  const big = 1 << lod;
  if (aspect >= 0) return [big, Math.max(1, big >> aspect)];
  return [Math.max(1, big >> -aspect), big];
}

/** Size in bytes of mip levels largeLod..smallLod. */
export function mipChainBytes(small: number, large: number, aspect: number, fmt: number): number {
  let n = 0;
  for (let l = large; l >= small; l--) {
    const [w, h] = lodDims(l, aspect);
    n += w * h * texelBytes(fmt);
  }
  return n;
}

function readTexInfo(m: Machine, p: number): TexDesc {
  const dv = m.mem.dv;
  return { addr: 0, smallLod: dv.getInt32(p, true), largeLod: dv.getInt32(p + 4, true), aspect: dv.getInt32(p + 8, true), format: dv.getInt32(p + 12, true) };
}

function gatherVertex(m: Machine, g: Glide, p: number, out: Float32Array, o: number): void {
  const dv = m.mem.dv;
  const L = g.layout;
  const f = (param: number, k = 0): number | undefined => {
    const off = L.get(param);
    return off === undefined ? undefined : dv.getFloat32(p + off + k * 4, true);
  };
  out[o + V_X] = f(0x01) ?? 0;
  out[o + V_Y] = f(0x01, 1) ?? 0;
  out[o + V_Z] = f(0x02) ?? 0;
  const q = f(0x04);
  const oow = f(0x03) ?? q ?? 1;
  out[o + V_OOW] = oow;
  const pargb = L.get(0x30);
  if (pargb !== undefined) {
    const c = dv.getUint32(p + pargb, true);
    out[o + V_A] = c >>> 24;
    out[o + V_R] = (c >>> 16) & 0xff;
    out[o + V_G] = (c >>> 8) & 0xff;
    out[o + V_B] = c & 0xff;
  } else {
    out[o + V_R] = f(0x20) ?? 255;
    out[o + V_G] = f(0x20, 1) ?? 255;
    out[o + V_B] = f(0x20, 2) ?? 255;
    out[o + V_A] = f(0x10) ?? 255;
  }
  out[o + V_S0] = f(0x40) ?? 0;
  out[o + V_T0] = f(0x40, 1) ?? 0;
  out[o + V_Q0] = f(0x50) ?? q ?? oow;
  out[o + V_S1] = f(0x41) ?? 0;
  out[o + V_T1] = f(0x41, 1) ?? 0;
  out[o + V_Q1] = f(0x51) ?? q ?? oow;
  out[o + V_FOG] = f(0x05) ?? 0;
  if (g.coordSpace === 1) {
    const w = 1 / (oow || 1);
    out[o + V_X] = (out[o + V_X] * w * 0.5 + 0.5) * g.width;
    out[o + V_Y] = (out[o + V_Y] * w * 0.5 + 0.5) * g.height;
  }
}

const GR_CMP_ALWAYS = 7;

const sideBar = (g: Glide) => (g.outWidth ? (g.outWidth - g.width) / 2 : 0);

/** Stretches 3D draws to the output width and centres flat 2D overlays (fixed depth, depth test off) at their 4:3 size. */
function widen(g: Glide, v: Float32Array, n: number): void {
  let flat = g.st.depthFunc === GR_CMP_ALWAYS;
  for (let i = 1; flat && i < n; i++) flat = v[i * VF + V_OOW] === v[V_OOW];
  const scale = flat ? 1 : g.outWidth / g.width, shift = flat ? sideBar(g) : 0;
  for (let i = 0; i < n; i++) v[i * VF + V_X] = v[i * VF + V_X] * scale + shift;
}

function outputClip(g: Glide, [x0, y0, x1, y1]: [number, number, number, number]): [number, number, number, number] {
  if (!g.outWidth) return [x0, y0, x1, y1];
  const k = g.outWidth / g.width;
  return [x0 <= 0 ? 0 : Math.round(x0 * k), y0, x1 >= g.width ? g.outWidth : Math.round(x1 * k), y1];
}

function drawPointers(m: Machine, g: Glide, ptrs: number[], mode: "tri" | "line" | "point"): void {
  let n = 0;
  for (const p of ptrs) {
    gatherVertex(m, g, p, g.batch, n * VF);
    n++;
  }
  if (mode === "tri") g.stats.tris += n / 3;
  if (g.outWidth) widen(g, g.batch, n);
  g.backend.draw(mode, g.batch, n, g.st);
}

/** Expands a Glide primitive list into a triangle list of vertex pointers. */
function expand(mode: number, ptrs: number[]): number[] {
  const out: number[] = [];
  if (mode === 6) return ptrs;
  if (mode === 4 || mode === 7) {
    for (let i = 2; i < ptrs.length; i++) {
      if (i & 1) out.push(ptrs[i - 1], ptrs[i - 2], ptrs[i]);
      else out.push(ptrs[i - 2], ptrs[i - 1], ptrs[i]);
    }
    return out;
  }
  if (mode === 5 || mode === 8 || mode === 3) {
    for (let i = 2; i < ptrs.length; i++) out.push(ptrs[0], ptrs[i - 1], ptrs[i]);
    return out;
  }
  return out;
}

export function registerGlide3x(m0: Machine): void {
  const strings: Record<number, number> = {};
  const str = (m: Machine, id: number, s: string) => (strings[id] ??= m.sysString(s));
  const st = (m: Machine) => {
    const s = glide(m).st;
    s.version++;
    return s;
  };
  const fn: Record<string, [number, Impl]> = {
    grGlideInit: [0, () => {}],
    grGlideShutdown: [0, (m) => { glide(m).open = false; }],
    grSstSelect: [4, () => {}],
    grSstWinOpen: [28, (m, a) => {
      const g = glide(m);
      const res = RES[a.u(1)] ?? [640, 480];
      g.width = res[0];
      g.height = res[1];
      g.open = true;
      g.colorFormat = a.u(3);
      g.st.clip = [0, 0, g.outWidth || g.width, g.height];
      g.backend.open(g.outWidth || g.width, g.height);
      m.log(`grSstWinOpen ${g.width}x${g.height} origin=${a.u(4)} buffers=${a.u(5)}/${a.u(6)}`);
      return 1;
    }],
    grSstWinClose: [4, (m) => { const g = glide(m); g.open = false; g.backend.close(); return 1; }],
    grSelectContext: [4, () => 1],
    grGet: [12, (m, a) => {
      const g = glide(m);
      const pname = a.u(0), len = a.u(1), p = a.u(2), dv = m.mem.dv;
      const vals: Record<number, number[]> = {
        0x01: [16], 0x02: [5, 6, 5, 0], 0x03: [0], 0x04: [64], 0x05: [32], 0x06: [256], 0x07: [256], 0x08: [0], 0x09: [0],
        0x0a: [256], 0x0b: [3], 0x0c: [4 << 20], 0x0d: [TMU_MEM], 0x0e: [0], 0x0f: [1], 0x10: [0], 0x11: [1], 0x12: [16],
        0x13: [1], 0x14: [0], 0x15: [1], 0x16: [1], 0x22: [0], 0x23: [0], 0x24: [8], 0x25: [0, 0],
        0x26: [0, 0, g.width, g.height], 0x27: [0, 0xffff], 0x28: [0, 0xffff], 0x2a: [8],
      };
      const v = vals[pname];
      if (!v) { m.log(`grGet unknown ${pname.toString(16)}`); return 0; }
      const n = Math.min(v.length, Math.floor(len / 4));
      for (let i = 0; i < n; i++) dv.setInt32(p + i * 4, v[i], true);
      return n * 4;
    }],
    grGetString: [4, (m, a) => {
      const id = a.u(0);
      const s = { 0xa0: "", 0xa1: "Voodoo2", 0xa2: "Glide", 0xa3: "3Dfx Interactive", 0xa4: "3.10.00.0658" }[id] ?? "";
      return str(m, id, s);
    }],
    grGetProcAddress: [4, (m, a) => { m.log(`grGetProcAddress(${a.str(0)}) -> NULL`); return 0; }],
    grCoordinateSpace: [4, (m, a) => { glide(m).coordSpace = a.u(0); }],
    grVertexLayout: [12, (m, a) => {
      const g = glide(m);
      if (a.u(2)) g.layout.set(a.u(0), a.u(1));
      else g.layout.delete(a.u(0));
    }],
    grViewport: [16, () => {}],
    grClipWindow: [16, (m, a) => { st(m).clip = outputClip(glide(m), [a.u(0), a.u(1), a.u(2), a.u(3)]); }],
    grEnable: [4, (m, a) => { st(m).enables.add(a.u(0)); }],
    grDisable: [4, (m, a) => { st(m).enables.delete(a.u(0)); }],
    grCullMode: [4, (m, a) => { st(m).cull = a.u(0); }],
    grColorCombine: [20, (m, a) => { st(m).colorCombine = [a.u(0), a.u(1), a.u(2), a.u(3), a.u(4)]; }],
    grAlphaCombine: [20, (m, a) => { st(m).alphaCombine = [a.u(0), a.u(1), a.u(2), a.u(3), a.u(4)]; }],
    grTexCombine: [28, (m, a) => { st(m).texCombine = [a.u(1), a.u(2), a.u(3), a.u(4), a.u(5), a.u(6)]; }],
    grConstantColorValue: [4, (m, a) => { st(m).constantColor = argb(m, a.u(0)); }],
    grAlphaBlendFunction: [16, (m, a) => { st(m).blend = [a.u(0), a.u(1), a.u(2), a.u(3)]; }],
    grAlphaTestFunction: [4, (m, a) => { st(m).alphaTestFunc = a.u(0); }],
    grAlphaTestReferenceValue: [4, (m, a) => { st(m).alphaRef = a.u(0) & 0xff; }],
    grDepthBufferMode: [4, (m, a) => { st(m).depthMode = a.u(0); }],
    grDepthBufferFunction: [4, (m, a) => { st(m).depthFunc = a.u(0); }],
    grDepthMask: [4, (m, a) => { st(m).depthMask = a.u(0) !== 0; }],
    grDepthBiasLevel: [4, (m, a) => { st(m).depthBias = a.i(0); }],
    grDepthRange: [8, () => {}],
    grColorMask: [8, (m, a) => { st(m).colorMask = a.u(0) !== 0; st(m).alphaMask = a.u(1) !== 0; }],
    grChromakeyMode: [4, (m, a) => { st(m).chromaMode = a.u(0); }],
    grChromakeyValue: [4, (m, a) => { st(m).chromaValue = argb(m, a.u(0)); }],
    grFogMode: [4, (m, a) => { st(m).fogMode = a.u(0); }],
    grFogColorValue: [4, (m, a) => { st(m).fogColor = argb(m, a.u(0)); }],
    grFogTable: [4, (m, a) => { st(m).fogTable = m.mem.u8.slice(a.u(0), a.u(0) + 64); }],
    guFogGenerateLinear: [12, (m, a) => {
      const p = a.u(0), near = a.f32(1), far = a.f32(2);
      for (let i = 0; i < 64; i++) {
        const w = fogIndexToW(i);
        let f = (w - near) / (far - near);
        f = Math.max(0, Math.min(1, f));
        m.mem.u8[p + i] = Math.round(f * 255);
      }
    }],
    guFogTableIndexToW: [4, (m, a) => { m.cpu.fpu.push(fogIndexToW(a.i(0))); }],
    grBufferClear: [12, (m, a) => {
      const g = glide(m);
      g.backend.clear(argb(m, a.u(0)), a.u(1) & 0xff, a.u(2), g.st);
    }],
    grBufferSwap: [4, (m, a) => {
      const g = glide(m);
      g.stats.swaps++;
      g.backend.swap(a.u(0));
      m.frameReady = true;
      m.cpu.stopReq = true;
      for (const f of m.onFrame) f();
    }],
    grBufferNumPending: [0, () => 0],
    grRenderBuffer: [4, () => {}],
    grFinish: [0, () => {}],
    grFlush: [0, () => {}],
    grDrawTriangle: [12, (m, a) => drawPointers(m, glide(m), [a.u(0), a.u(1), a.u(2)], "tri")],
    grDrawLine: [8, (m, a) => drawPointers(m, glide(m), [a.u(0), a.u(1)], "line")],
    grDrawPoint: [4, (m, a) => drawPointers(m, glide(m), [a.u(0)], "point")],
    grDrawVertexArray: [12, (m, a) => {
      const ptrs: number[] = [];
      for (let i = 0; i < a.u(1); i++) ptrs.push(m.mem.dv.getUint32(a.u(2) + i * 4, true));
      emitList(m, a.u(0), ptrs);
    }],
    grDrawVertexArrayContiguous: [16, (m, a) => {
      const ptrs: number[] = [];
      for (let i = 0; i < a.u(1); i++) ptrs.push(a.u(2) + i * a.u(3));
      emitList(m, a.u(0), ptrs);
    }],
    grAADrawTriangle: [24, (m, a) => drawPointers(m, glide(m), [a.u(0), a.u(1), a.u(2)], "tri")],

    grTexMinAddress: [4, () => 0],
    grTexMaxAddress: [4, () => TMU_MEM - 8],
    grTexTextureMemRequired: [8, (m, a) => {
      const t = readTexInfo(m, a.u(1));
      return (mipChainBytes(t.smallLod, t.largeLod, t.aspect, t.format) + 7) & ~7;
    }],
    grTexCalcMemRequired: [16, (m, a) => (mipChainBytes(a.i(0), a.i(1), a.i(2), a.i(3)) + 7) & ~7],
    grTexDownloadMipMap: [16, (m, a) => {
      const g = glide(m);
      const t = readTexInfo(m, a.u(3));
      const data = m.mem.dv.getUint32(a.u(3) + 16, true);
      const n = mipChainBytes(t.smallLod, t.largeLod, t.aspect, t.format);
      const addr = a.u(1);
      if (addr + n > TMU_MEM) { m.log(`texture download out of TMU range ${addr}+${n}`); return; }
      g.tmu.set(m.mem.u8.subarray(data, data + n), addr);
      g.backend.texWritten(addr, n);
    }],
    grTexDownloadMipMapLevel: [32, (m, a) => {
      const g = glide(m);
      const lod = a.i(2), large = a.i(3), aspect = a.i(4), fmt = a.i(5), data = a.u(7);
      let off = 0;
      for (let l = large; l > lod; l--) { const [w, h] = lodDims(l, aspect); off += w * h * texelBytes(fmt); }
      const [w, h] = lodDims(lod, aspect);
      const n = w * h * texelBytes(fmt);
      g.tmu.set(m.mem.u8.subarray(data, data + n), a.u(1) + off);
      g.backend.texWritten(a.u(1) + off, n);
    }],
    grTexSource: [16, (m, a) => {
      const t = readTexInfo(m, a.u(3));
      t.addr = a.u(1);
      st(m).tex = t;
      st(m).texVersion++;
    }],
    grTexDownloadTable: [8, (m, a) => {
      const g = glide(m);
      const p = a.u(1);
      if (a.u(0) === 0x2 || a.u(0) === 0x3) {
        for (let i = 0; i < 256; i++) g.palette[i] = m.mem.dv.getUint32(p + i * 4, true);
        g.backend.paletteChanged(g.palette, false);
      } else m.log(`grTexDownloadTable type ${a.u(0)} (NCC) ignored`);
    }],
    grTexDownloadTablePartial: [16, (m, a) => {
      const g = glide(m);
      const p = a.u(1);
      for (let i = a.u(2); i <= a.u(3) && i < 256; i++) g.palette[i] = m.mem.dv.getUint32(p + i * 4, true);
      g.backend.paletteChanged(g.palette, false);
    }],
    grTexClampMode: [12, (m, a) => { st(m).clampS = a.u(1); st(m).clampT = a.u(2); }],
    grTexFilterMode: [12, (m, a) => { st(m).minFilter = a.u(1); st(m).magFilter = a.u(2); }],
    grTexMipMapMode: [12, (m, a) => { st(m).mipMode = a.u(1); }],
    grTexLodBiasValue: [8, (m, a) => { st(m).lodBias = a.f32(1); }],
    grTexNCCTable: [4, () => {}],
    grTexMultibase: [8, () => {}],
    grTexDetailControl: [16, () => {}],
    grLfbLock: [24, (m, a) => {
      const g = glide(m);
      const type = a.u(0), buffer = a.u(1), fmt = a.u(2), info = a.u(5);
      if (!g.lfbBuf) g.lfbBuf = m.as.reserve(g.width * g.height * 4 + 0x1000, "glide-lfb");
      const write = (type & 1) === 1;
      const bpp = fmt === 0x4 || fmt === 0x5 ? 4 : 2;
      if (!write) {
        const px = g.backend.lfbRead(buffer, g.width, g.height);
        m.mem.u8.set(new Uint8Array(px.buffer, px.byteOffset, px.byteLength), g.lfbBuf);
      } else if (bpp === 2) new Uint16Array(m.mem.buf, g.lfbBuf, g.width * g.height).fill(LFB_UNTOUCHED16);
      else new Uint32Array(m.mem.buf, g.lfbBuf, g.width * g.height).fill(LFB_UNTOUCHED32);
      g.lfbLock = { buffer, write, fmt: write ? fmt : 0 };
      const dv = m.mem.dv;
      dv.setUint32(info + 4, g.lfbBuf, true);
      dv.setUint32(info + 8, g.width * (write ? bpp : 2), true);
      dv.setUint32(info + 12, write ? fmt : 0, true);
      dv.setUint32(info + 16, 0, true);
      return 1;
    }],
    grLfbUnlock: [8, (m) => {
      const g = glide(m);
      const lk = g.lfbLock;
      g.lfbLock = null;
      if (lk && lk.write) {
        const bpp = lk.fmt === 0x4 || lk.fmt === 0x5 ? 4 : 2;
        const n = g.width * g.height;
        const px = bpp === 4 ? new Uint32Array(m.mem.buf.slice(g.lfbBuf, g.lfbBuf + n * 4)) : new Uint16Array(m.mem.buf.slice(g.lfbBuf, g.lfbBuf + n * 2));
        g.backend.lfbWrite(lk.buffer, sideBar(g), 0, g.width, g.height, px, lk.fmt);
      }
      return 1;
    }],
    grLfbWriteRegion: [36, (m, a) => {
      const g = glide(m);
      const buffer = a.u(0), x = a.u(1), y = a.u(2), fmt = a.u(3), w = a.u(4), h = a.u(5), stride = a.u(7), data = a.u(8);
      const bpp = fmt === 0x4 || fmt === 0x5 ? 4 : 2;
      const px = bpp === 4 ? new Uint32Array(w * h) : new Uint16Array(w * h);
      const dv = m.mem.dv;
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          const o = data + j * stride + i * bpp;
          px[j * w + i] = bpp === 4 ? dv.getUint32(o, true) : dv.getUint16(o, true);
        }
      }
      g.backend.lfbWrite(buffer, x + sideBar(g), y, w, h, px, fmt);
      return 1;
    }],
    grLfbReadRegion: [28, (m, a) => {
      const g = glide(m);
      const px = g.backend.lfbRead(a.u(0), g.width, g.height);
      const x = a.u(1), y = a.u(2), w = a.u(3), h = a.u(4), stride = a.u(5), dst = a.u(6);
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) m.mem.dv.setUint16(dst + j * stride + i * 2, px[(y + j) * g.width + x + i] ?? 0, true);
      return 1;
    }],
    grLfbConstantAlpha: [4, () => {}],
    grLfbConstantDepth: [4, () => {}],
    grLfbWriteColorFormat: [4, () => {}],
    grLfbWriteColorSwizzle: [8, () => {}],
    grSplash: [20, () => {}],
    grGammaCorrectionRGB: [12, () => {}],
    grLoadGammaTable: [16, () => {}],
    grDitherMode: [4, () => {}],
    grStippleMode: [4, () => {}],
    grStipplePattern: [4, () => {}],
    grSstOrigin: [4, () => {}],
    grErrorSetCallback: [4, () => {}],
    grReset: [4, () => 1],
    grQueryResolutions: [8, () => 0],
    grSstWinOpenExt: [32, () => 0],
  };
  const decorated: Record<string, [number, Impl]> = {};
  for (const [name, def] of Object.entries(fn)) decorated[`_${name}@${def[0]}`] = def;
  m0.register("glide3x.dll", decorated);
  void u32;
}

function emitList(m: Machine, mode: number, ptrs: number[]): void {
  const g = glide(m);
  if (mode === 0) return drawPointers(m, g, ptrs, "point");
  if (mode === 1) {
    const l: number[] = [];
    for (let i = 1; i < ptrs.length; i++) l.push(ptrs[i - 1], ptrs[i]);
    return drawPointers(m, g, l, "line");
  }
  if (mode === 2) return drawPointers(m, g, ptrs, "line");
  const tris = expand(mode, ptrs);
  for (let i = 0; i < tris.length; i += 3 * 1024) drawPointers(m, g, tris.slice(i, i + 3 * 1024), "tri");
}

function fogIndexToW(i: number): number {
  return Math.pow(2, 3 + (i >> 2)) / (8 - (i & 3));
}
