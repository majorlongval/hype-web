import { expect, it } from "vitest";
import { Args, HLE_BASE, Machine } from "../src/win32/machine";
import { glide, NullBackend, registerGlide3x, VF, V_X } from "../src/win32/glide3x";
import { VFS } from "../src/win32/vfs";

const GR_RESOLUTION_640x480 = 0x7;
const GR_COLORFORMAT_ARGB = 0, GR_COLORFORMAT_ABGR = 1, GR_COLORFORMAT_RGBA = 2, GR_COLORFORMAT_BGRA = 3;
const GR_PARAM_XY = 0x01, GR_PARAM_Q = 0x03, GR_PARAM_ENABLE = 1;
const GR_CMP_LEQUAL = 3, GR_CMP_ALWAYS = 7;
const GR_COMBINE_FUNCTION_SCALE_OTHER = 3, GR_COMBINE_FACTOR_ONE = 8, GR_COMBINE_OTHER_TEXTURE = 1;

function openGlide(colorFormat: number, outWidth = 0) {
  const m = new Machine(new VFS(), { now: () => 0, log: () => {} });
  registerGlide3x(m);
  const cleared: number[] = [];
  const opened: number[][] = [];
  const drawn: number[][] = [];
  const written: number[][] = [];
  class Recorder extends NullBackend {
    override open(width?: number, height?: number): void { opened.push([width!, height!]); }
    override clear(color?: number): void { cleared.push(color!); }
    override draw(_mode: string, v: Float32Array, count: number): void {
      drawn.push(Array.from({ length: count }, (_, i) => v[i * VF + V_X]));
    }
    override lfbWrite(_b?: number, x?: number, y?: number, w?: number, h?: number): void { written.push([x!, y!, w!, h!]); }
  }
  glide(m).backend = new Recorder();
  glide(m).outWidth = outWidth;
  const scratch = m.sysAlloc(64);
  const call = (name: string, ...args: number[]) => {
    args.forEach((n, i) => m.mem.dv.setUint32(scratch + i * 4, n >>> 0, true));
    const fn = m.fns[(m.thunk("glide3x.dll", `_${name}@${args.length * 4}`) - HLE_BASE) / 16];
    return fn.impl!(m, new Args(m, scratch));
  };
  call("grSstWinOpen", 0, GR_RESOLUTION_640x480, 0, colorFormat, 0, 2, 1);
  const triangle = (verts: [number, number, number][]) => {
    const p = m.sysAlloc(36);
    verts.forEach(([x, y, oow], i) => {
      m.mem.dv.setFloat32(p + i * 12, x, true);
      m.mem.dv.setFloat32(p + i * 12 + 4, y, true);
      m.mem.dv.setFloat32(p + i * 12 + 8, oow, true);
    });
    call("grVertexLayout", GR_PARAM_XY, 0, GR_PARAM_ENABLE);
    call("grVertexLayout", GR_PARAM_Q, 8, GR_PARAM_ENABLE);
    call("grDrawTriangle", p, p + 12, p + 24);
    return drawn.at(-1);
  };
  return { m, st: glide(m).st, call, cleared, opened, triangle, written };
}

it.each([
  ["ARGB", GR_COLORFORMAT_ARGB, 0x80a3745b],
  ["ABGR", GR_COLORFORMAT_ABGR, 0x805b74a3],
  ["RGBA", GR_COLORFORMAT_RGBA, 0xa3745b80],
  ["BGRA", GR_COLORFORMAT_BGRA, 0x5b74a380],
])("reads %s colours as ARGB for the chroma key, constant, fog and clear colours", (_name, format, value) => {
  const { st, call, cleared } = openGlide(format);

  call("grChromakeyValue", value);
  call("grConstantColorValue", value);
  call("grFogColorValue", value);
  call("grBufferClear", value, 0, 0);

  expect(st.chromaValue >>> 0).toBe(0x80a3745b);
  expect(st.constantColor >>> 0).toBe(0x80a3745b);
  expect(st.fogColor >>> 0).toBe(0x80a3745b);
  expect(cleared.map((c) => c >>> 0)).toEqual([0x80a3745b]);
});

it("opens the output at the wide width while the game keeps its 640x480 screen", () => {
  const { m, st, opened } = openGlide(GR_COLORFORMAT_ARGB, 854);

  expect(opened).toEqual([[854, 480]]);
  expect(glide(m).width).toBe(640);
  expect(st.clip).toEqual([0, 0, 854, 480]);
});

it("stretches 3D draws across the wide output", () => {
  const { call, triangle } = openGlide(GR_COLORFORMAT_ARGB, 854);

  call("grDepthBufferFunction", GR_CMP_LEQUAL);

  expect(triangle([[0, 0, 0.001], [320, 10, 0.002], [640, 20, 0.003]])).toEqual([0, 427, 854]);
});

it("centres flat 2D overlays at their original size", () => {
  const { call, triangle } = openGlide(GR_COLORFORMAT_ARGB, 854);

  call("grDepthBufferFunction", GR_CMP_ALWAYS);

  expect(triangle([[80, 0, 0.25], [320, 10, 0.25], [560, 20, 0.25]])).toEqual([187, 427, 667]);
});

it("centres a full-screen picture at its original size", () => {
  const { call, triangle } = openGlide(GR_COLORFORMAT_ARGB, 854);

  call("grDepthBufferFunction", GR_CMP_ALWAYS);
  call("grColorCombine", GR_COMBINE_FUNCTION_SCALE_OTHER, GR_COMBINE_FACTOR_ONE, 0, GR_COMBINE_OTHER_TEXTURE, 0);

  expect(triangle([[0, 0, 0.25], [639, 0, 0.25], [639, 479, 0.25]])).toEqual([107, 746, 746]);
});

it.each([
  ["a plain cinematic bar", false, 60],
  ["a textured cinematic bar", true, 60],
  ["a plain full-screen fade", false, 479],
])("stretches %s across the wide output", (_name, textured, bottom) => {
  const { call, triangle } = openGlide(GR_COLORFORMAT_ARGB, 854);

  call("grDepthBufferFunction", GR_CMP_ALWAYS);
  if (textured) call("grColorCombine", GR_COMBINE_FUNCTION_SCALE_OTHER, GR_COMBINE_FACTOR_ONE, 0, GR_COMBINE_OTHER_TEXTURE, 0);

  expect(triangle([[0, 0, 0.25], [640, 0, 0.25], [640, bottom, 0.25]])).toEqual([0, 854, 854]);
});

it("treats draws with varying depth as 3D even when the depth test is off", () => {
  const { call, triangle } = openGlide(GR_COLORFORMAT_ARGB, 854);

  call("grDepthBufferFunction", GR_CMP_ALWAYS);

  expect(triangle([[0, 0, 0.25], [320, 10, 0.5], [640, 20, 0.25]])).toEqual([0, 427, 854]);
});

it("leaves draws untouched when widescreen is off", () => {
  const { call, triangle } = openGlide(GR_COLORFORMAT_ARGB);

  call("grDepthBufferFunction", GR_CMP_LEQUAL);

  expect(triangle([[0, 0, 0.001], [320, 10, 0.002], [640, 20, 0.003]])).toEqual([0, 320, 640]);
});

it("widens a full-screen clip window and scales a partial one", () => {
  const { st, call } = openGlide(GR_COLORFORMAT_ARGB, 854);

  call("grClipWindow", 0, 0, 640, 480);
  const full = [...st.clip];
  call("grClipWindow", 160, 0, 480, 480);

  expect(full).toEqual([0, 0, 854, 480]);
  expect(st.clip).toEqual([214, 0, 641, 480]);
});

it("centres frame buffer writes", () => {
  const { m, call, written } = openGlide(GR_COLORFORMAT_ARGB, 854);

  call("grLfbWriteRegion", 1, 10, 20, 0, 4, 2, 0, 8, m.sysAlloc(16));

  expect(written).toEqual([[117, 20, 4, 2]]);
});
