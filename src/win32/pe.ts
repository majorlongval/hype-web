export interface PeSection {
  name: string;
  va: number;
  vsize: number;
  rawPtr: number;
  rawSize: number;
  chars: number;
}
export interface PeImport {
  dll: string;
  /** RVA of the IAT slot for each imported symbol. */
  entries: { name: string | null; ordinal: number; iatRva: number }[];
}
export interface PeExport {
  name: string | null;
  ordinal: number;
  rva: number;
  forward: string | null;
}
export interface PeFile {
  data: Uint8Array;
  imageBase: number;
  sizeOfImage: number;
  sizeOfHeaders: number;
  entry: number;
  isDll: boolean;
  sections: PeSection[];
  imports: PeImport[];
  exports: PeExport[];
  exportName: string;
  relocRva: number;
  relocSize: number;
  resourceRva: number;
  resourceSize: number;
  tlsRva: number;
  stackReserve: number;
  heapReserve: number;
  subsystem: number;
}

export function parsePe(data: Uint8Array): PeFile {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (dv.getUint16(0, true) !== 0x5a4d) throw new Error("not an MZ file");
  const peOff = dv.getUint32(0x3c, true);
  if (dv.getUint32(peOff, true) !== 0x4550) throw new Error("not a PE file");
  const nSections = dv.getUint16(peOff + 6, true);
  const optSize = dv.getUint16(peOff + 20, true);
  const chars = dv.getUint16(peOff + 22, true);
  const opt = peOff + 24;
  if (dv.getUint16(opt, true) !== 0x10b) throw new Error("not PE32");
  const entry = dv.getUint32(opt + 16, true);
  const imageBase = dv.getUint32(opt + 28, true);
  const sizeOfImage = dv.getUint32(opt + 56, true);
  const sizeOfHeaders = dv.getUint32(opt + 60, true);
  const subsystem = dv.getUint16(opt + 68, true);
  const stackReserve = dv.getUint32(opt + 72, true);
  const heapReserve = dv.getUint32(opt + 80, true);
  const nDirs = dv.getUint32(opt + 92, true);
  const dir = (i: number): [number, number] =>
    i < nDirs ? [dv.getUint32(opt + 96 + i * 8, true), dv.getUint32(opt + 100 + i * 8, true)] : [0, 0];

  const sections: PeSection[] = [];
  const secOff = opt + optSize;
  for (let i = 0; i < nSections; i++) {
    const o = secOff + i * 40;
    let name = "";
    for (let k = 0; k < 8; k++) {
      const c = data[o + k];
      if (!c) break;
      name += String.fromCharCode(c);
    }
    sections.push({
      name,
      vsize: dv.getUint32(o + 8, true),
      va: dv.getUint32(o + 12, true),
      rawSize: dv.getUint32(o + 16, true),
      rawPtr: dv.getUint32(o + 20, true),
      chars: dv.getUint32(o + 36, true),
    });
  }

  const rvaToOff = (rva: number): number => {
    if (rva < sizeOfHeaders) return rva;
    for (const s of sections) {
      if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize)) return rva - s.va + s.rawPtr;
    }
    return -1;
  };
  const cstr = (rva: number): string => {
    let o = rvaToOff(rva), s = "";
    if (o < 0) return "";
    while (data[o]) s += String.fromCharCode(data[o++]);
    return s;
  };

  const imports: PeImport[] = [];
  const [impRva] = dir(1);
  if (impRva) {
    for (let d = rvaToOff(impRva); ; d += 20) {
      const ilt = dv.getUint32(d, true);
      const nameRva = dv.getUint32(d + 12, true);
      const iat = dv.getUint32(d + 16, true);
      if (!nameRva && !iat) break;
      const entries: PeImport["entries"] = [];
      const lookup = ilt || iat;
      for (let k = 0; ; k++) {
        const v = dv.getUint32(rvaToOff(lookup) + k * 4, true);
        if (!v) break;
        if (v & 0x80000000) entries.push({ name: null, ordinal: v & 0xffff, iatRva: iat + k * 4 });
        else entries.push({ name: cstr(v + 2), ordinal: dv.getUint16(rvaToOff(v), true), iatRva: iat + k * 4 });
      }
      imports.push({ dll: cstr(nameRva), entries });
    }
  }

  const exports: PeExport[] = [];
  let exportName = "";
  const [expRva, expSize] = dir(0);
  if (expRva) {
    const e = rvaToOff(expRva);
    exportName = cstr(dv.getUint32(e + 12, true));
    const ordBase = dv.getUint32(e + 16, true);
    const nFuncs = dv.getUint32(e + 20, true);
    const nNames = dv.getUint32(e + 24, true);
    const funcs = rvaToOff(dv.getUint32(e + 28, true));
    const names = rvaToOff(dv.getUint32(e + 32, true));
    const ords = rvaToOff(dv.getUint32(e + 36, true));
    const nameOf = new Map<number, string>();
    for (let i = 0; i < nNames; i++) {
      nameOf.set(dv.getUint16(ords + i * 2, true), cstr(dv.getUint32(names + i * 4, true)));
    }
    for (let i = 0; i < nFuncs; i++) {
      const rva = dv.getUint32(funcs + i * 4, true);
      if (!rva) continue;
      const fwd = rva >= expRva && rva < expRva + expSize ? cstr(rva) : null;
      exports.push({ name: nameOf.get(i) ?? null, ordinal: ordBase + i, rva, forward: fwd });
    }
  }

  const [relocRva, relocSize] = dir(5);
  const [resourceRva, resourceSize] = dir(2);
  const [tlsRva] = dir(9);
  return {
    data, imageBase, sizeOfImage, sizeOfHeaders, entry, isDll: (chars & 0x2000) !== 0, sections, imports,
    exports, exportName, relocRva, relocSize, resourceRva, resourceSize, tlsRva, stackReserve, heapReserve,
    subsystem,
  };
}

/** Copies headers and sections into guest memory at `base` and applies base relocations. */
export function mapImage(pe: PeFile, u8: Uint8Array, base: number): void {
  const dv = new DataView(u8.buffer);
  u8.fill(0, base, base + pe.sizeOfImage);
  u8.set(pe.data.subarray(0, Math.min(pe.sizeOfHeaders, pe.data.length)), base);
  for (const s of pe.sections) {
    const n = Math.min(s.rawSize, s.vsize || s.rawSize, pe.data.length - s.rawPtr);
    if (n > 0 && s.rawPtr) u8.set(pe.data.subarray(s.rawPtr, s.rawPtr + n), base + s.va);
  }
  const delta = (base - pe.imageBase) | 0;
  if (delta === 0 || !pe.relocRva) return;
  let p = base + pe.relocRva;
  const end = p + pe.relocSize;
  while (p < end) {
    const pageRva = dv.getUint32(p, true);
    const blockSize = dv.getUint32(p + 4, true);
    if (!blockSize) break;
    for (let o = 8; o < blockSize; o += 2) {
      const e = dv.getUint16(p + o, true);
      const type = e >> 12, off = e & 0xfff;
      const at = base + pageRva + off;
      if (type === 3) dv.setUint32(at, (dv.getUint32(at, true) + delta) >>> 0, true);
      else if (type === 1) dv.setUint16(at, (dv.getUint16(at, true) + (delta >>> 16)) & 0xffff, true);
      else if (type === 2) dv.setUint16(at, (dv.getUint16(at, true) + (delta & 0xffff)) & 0xffff, true);
      else if (type !== 0) throw new Error(`unsupported relocation type ${type}`);
    }
    p += blockSize;
  }
}
