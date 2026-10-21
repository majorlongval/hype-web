import type { Machine, GuestModule } from "./machine";

function nameMatches(m: Machine, rsrcBase: number, entryName: number, want: number): boolean {
  const isStr = (entryName & 0x80000000) !== 0;
  if (want < 0x10000) return !isStr && (entryName & 0xffff) === want;
  let s = m.mem.readCString(want);
  if (s.startsWith("#")) return !isStr && (entryName & 0xffff) === parseInt(s.slice(1), 10);
  if (!isStr) return false;
  const p = rsrcBase + (entryName & 0x7fffffff);
  const len = m.mem.dv.getUint16(p, true);
  let n = "";
  for (let i = 0; i < len; i++) n += String.fromCharCode(m.mem.dv.getUint16(p + 2 + i * 2, true));
  return n.toUpperCase() === s.toUpperCase();
}

function findIn(m: Machine, rsrcBase: number, dir: number, want: number | null): number {
  const dv = m.mem.dv;
  const n = dv.getUint16(dir + 12, true) + dv.getUint16(dir + 14, true);
  for (let i = 0; i < n; i++) {
    const e = dir + 16 + i * 8;
    if (want === null || nameMatches(m, rsrcBase, dv.getUint32(e, true), want)) return dv.getUint32(e + 4, true);
  }
  return -1;
}

/** Returns the guest address of the IMAGE_RESOURCE_DATA_ENTRY (used as HRSRC), or 0. */
export function findResource(m: Machine, mod: GuestModule, type: number, name: number): number {
  if (!mod.pe || !mod.pe.resourceRva) return 0;
  const base = mod.base + mod.pe.resourceRva;
  let off = findIn(m, base, base, type);
  if (off < 0 || !(off & 0x80000000)) return 0;
  off = findIn(m, base, base + (off & 0x7fffffff), name);
  if (off < 0) return 0;
  if (off & 0x80000000) {
    off = findIn(m, base, base + (off & 0x7fffffff), null);
    if (off < 0) return 0;
  }
  return base + off;
}

/** Address and size of resource data for (type, name), or null. */
export function resourceData(m: Machine, mod: GuestModule, type: number, name: number): [number, number] | null {
  const e = findResource(m, mod, type, name);
  if (!e) return null;
  return [mod.base + m.mem.dv.getUint32(e, true), m.mem.dv.getUint32(e + 4, true)];
}

export function loadString(m: Machine, mod: GuestModule, id: number): string | null {
  const r = resourceData(m, mod, 6, (id >> 4) + 1);
  if (!r) return null;
  let p = r[0];
  for (let i = 0; i < (id & 15); i++) p += 2 + m.mem.dv.getUint16(p, true) * 2;
  const len = m.mem.dv.getUint16(p, true);
  if (!len) return null;
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(m.mem.dv.getUint16(p + 2 + i * 2, true));
  return s;
}
