import { expect, it } from "vitest";
import { Args, HLE_BASE, Machine } from "../src/win32/machine";
import { glide, NullBackend, registerGlide3x } from "../src/win32/glide3x";
import { VFS } from "../src/win32/vfs";

const GR_RESOLUTION_640x480 = 0x7;
const GR_COLORFORMAT_ARGB = 0, GR_COLORFORMAT_ABGR = 1, GR_COLORFORMAT_RGBA = 2, GR_COLORFORMAT_BGRA = 3;

function openGlide(colorFormat: number) {
  const m = new Machine(new VFS(), { now: () => 0, log: () => {} });
  registerGlide3x(m);
  const cleared: number[] = [];
  class Recorder extends NullBackend {
    override clear(color?: number): void { cleared.push(color!); }
  }
  glide(m).backend = new Recorder();
  const scratch = m.sysAlloc(64);
  const call = (name: string, ...args: number[]) => {
    args.forEach((n, i) => m.mem.dv.setUint32(scratch + i * 4, n >>> 0, true));
    const fn = m.fns[(m.thunk("glide3x.dll", `_${name}@${args.length * 4}`) - HLE_BASE) / 16];
    return fn.impl!(m, new Args(m, scratch));
  };
  call("grSstWinOpen", 0, GR_RESOLUTION_640x480, 0, colorFormat, 0, 2, 1);
  return { st: glide(m).st, call, cleared };
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
