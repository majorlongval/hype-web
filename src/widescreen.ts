import type { Machine } from "./win32/machine";
import { glide } from "./win32/glide3x";

const SET_CAMERA_ASPECT = [0xd9, 0x44, 0x24, 0x0c, 0xd8, 0x4c, 0x24, 0x08, 0xd9, 0x44, 0x24, 0x08, 0x8b, 0x44, 0x24, 0x04, 0xd9, 0x58, 0x64, 0xd9, 0x58, 0x68, 0xc3];

export function applyWidescreen(m: Machine, width: number, log: (s: string) => void): boolean {
  const mem = m.mem.u8;
  const owner = m.modules.find((mod) => !mod.hle && mod.exports.has("GLI_xSetCameraAspectAndRatio"));
  const fn = owner ? owner.base + owner.exports.get("GLI_xSetCameraAspectAndRatio")! : 0;
  if (!fn || SET_CAMERA_ASPECT.some((b, i) => mem[fn + i] !== b)) {
    log("widescreen: camera function not found, staying 4:3");
    return false;
  }
  const g = glide(m);
  const boost = width / g.width;
  m.register("hype-wide.dll", {
    SetCameraAspectAndRatio: [0, (mm, a) => {
      const cam = a.u(0), h = a.f32(1), r = a.f32(2);
      mm.mem.dv.setFloat32(cam + 0x64, 2 * Math.atan(Math.tan(h / 2) * boost), true);
      mm.mem.dv.setFloat32(cam + 0x68, h * r, true);
    }],
  });
  const thunk = m.thunk("hype-wide.dll", "SetCameraAspectAndRatio");
  const rel = (thunk - (fn + 5)) >>> 0;
  mem.set([0xe9, rel & 0xff, (rel >>> 8) & 0xff, (rel >>> 16) & 0xff, rel >>> 24], fn);
  g.outWidth = width;
  log(`widescreen: ${width}x${g.height}, camera hook at 0x${fn.toString(16)}`);
  return true;
}
