import { expect, it } from "vitest";
import { Args, HLE_BASE, Machine } from "../src/win32/machine";
import { glide, registerGlide3x } from "../src/win32/glide3x";
import { VFS } from "../src/win32/vfs";
import { applyWidescreen } from "../src/widescreen";

const SET_CAMERA_ASPECT = [0xd9, 0x44, 0x24, 0x0c, 0xd8, 0x4c, 0x24, 0x08, 0xd9, 0x44, 0x24, 0x08, 0x8b, 0x44, 0x24, 0x04, 0xd9, 0x58, 0x64, 0xd9, 0x58, 0x68, 0xc3];
const BASE = 0x400000, RVA = 0x73cc0, FN = BASE + RVA;

function gameWithCameraFunction(bytes = SET_CAMERA_ASPECT) {
  const m = new Machine(new VFS(), { now: () => 0, log: () => {} });
  registerGlide3x(m);
  m.modules.push({ name: "maidfxvr.exe", path: "C:\\Hype\\MaiDFXvr.exe", base: BASE, size: 0x200000, pe: null, hle: false, exports: new Map([["GLI_xSetCameraAspectAndRatio", RVA]]), ordinals: new Map(), refs: 1, entry: 0 } as never);
  m.mem.u8.set(bytes, FN);
  const logs: string[] = [];
  return { m, logs, log: (s: string) => logs.push(s) };
}

function callJumpTarget(m: Machine, cam: number, angle: number, ratio: number) {
  const dv = m.mem.dv;
  const target = (FN + 5 + dv.getInt32(FN + 1, true)) >>> 0;
  const args = m.sysAlloc(12);
  dv.setUint32(args, cam, true);
  dv.setFloat32(args + 4, angle, true);
  dv.setFloat32(args + 8, ratio, true);
  m.fns[(target - HLE_BASE) / 16].impl!(m, new Args(m, args));
  return [dv.getFloat32(cam + 0x64, true), dv.getFloat32(cam + 0x68, true)];
}

it("widens the camera's horizontal angle and keeps its vertical angle", () => {
  const { m, log } = gameWithCameraFunction();
  const cam = m.sysAlloc(0x100);

  expect(applyWidescreen(m, 854, log)).toBe(true);
  const [horizontal, vertical] = callJumpTarget(m, cam, 1.5, 0.81313);

  expect(m.mem.u8[FN]).toBe(0xe9);
  expect(Math.tan(horizontal / 2) / Math.tan(0.75)).toBeCloseTo(854 / 640, 4);
  expect(vertical).toBeCloseTo(1.5 * 0.81313, 5);
  expect(glide(m).outWidth).toBe(854);
});

it("leaves an unknown game untouched", () => {
  const changed = [...SET_CAMERA_ASPECT];
  changed[20] = 0x60;
  const { m, logs, log } = gameWithCameraFunction(changed);

  expect(applyWidescreen(m, 854, log)).toBe(false);
  expect([...m.mem.u8.subarray(FN, FN + changed.length)]).toEqual(changed);
  expect(glide(m).outWidth).toBe(0);
  expect(logs).toEqual(["widescreen: camera function not found, staying 4:3"]);
});
