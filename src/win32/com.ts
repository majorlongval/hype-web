import type { Machine, Impl } from "./machine";

/** Builds a guest COM object whose vtable entries are HLE callbacks. Returns the interface pointer. */
export function comObject(m: Machine, iface: string, methods: [string, number, Impl][], extraBytes = 0): number {
  const vtblKey = `vtbl:${iface}`;
  let vtbl: number = m.sub[vtblKey];
  if (!vtbl) {
    vtbl = m.sysAlloc(methods.length * 4, 4);
    methods.forEach(([name, pop, impl], i) => m.mem.dv.setUint32(vtbl + i * 4, m.callback(`${iface}::${name}`, pop, impl), true));
    m.sub[vtblKey] = vtbl;
  }
  const obj = m.processHeap.alloc(4 + extraBytes, true);
  m.mem.dv.setUint32(obj, vtbl, true);
  return obj;
}

export function readGuid(m: Machine, p: number): string {
  if (!p) return "null";
  const dv = m.mem.dv;
  const h = (v: number, n: number) => v.toString(16).padStart(n, "0");
  let s = `${h(dv.getUint32(p, true), 8)}-${h(dv.getUint16(p + 4, true), 4)}-${h(dv.getUint16(p + 6, true), 4)}-`;
  for (let i = 8; i < 16; i++) s += (i === 10 ? "-" : "") + h(m.mem.u8[p + i], 2);
  return s.toUpperCase();
}

export function writeGuid(m: Machine, p: number, g: string): void {
  const hex = g.replace(/-/g, "");
  const dv = m.mem.dv;
  dv.setUint32(p, parseInt(hex.slice(0, 8), 16), true);
  dv.setUint16(p + 4, parseInt(hex.slice(8, 12), 16), true);
  dv.setUint16(p + 6, parseInt(hex.slice(12, 16), 16), true);
  for (let i = 0; i < 8; i++) m.mem.u8[p + 8 + i] = parseInt(hex.slice(16 + i * 2, 18 + i * 2), 16);
}

export const E_NOINTERFACE = 0x80004002, E_FAIL = 0x80004005, E_NOTIMPL = 0x80004001, E_INVALIDARG = 0x80070057;
