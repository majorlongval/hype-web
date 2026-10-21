import { type FileSource, readBytes } from "../win32/vfs";

const SECTOR = 2048;
const FIRST_DESCRIPTOR = 16;
const DIR_FLAG = 0x02;

export interface IsoFile {
  path: string;
  lba: number;
  size: number;
}

export interface IsoImage {
  label: string;
  files: IsoFile[];
}

interface Root {
  lba: number;
  size: number;
  label: string;
  joliet: boolean;
}

function ascii(b: Uint8Array): string {
  return String.fromCharCode(...b);
}

function ucs2be(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
  return s;
}

function u32(b: Uint8Array, off: number): number {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}

function isJoliet(d: Uint8Array): boolean {
  return d[88] === 0x25 && d[89] === 0x2f && (d[90] === 0x40 || d[90] === 0x43 || d[90] === 0x45);
}

function cleanName(name: string): string {
  const semi = name.indexOf(";");
  const base = semi >= 0 ? name.slice(0, semi) : name;
  return base.endsWith(".") ? base.slice(0, -1) : base;
}

function findRoot(src: FileSource): Root {
  let primary: Root | null = null;
  for (let s = FIRST_DESCRIPTOR; (s + 1) * SECTOR <= src.size; s++) {
    const d = readBytes(src, s * SECTOR, SECTOR);
    if (ascii(d.subarray(1, 6)) !== "CD001") break;
    const type = d[0];
    if (type === 255) break;
    if (type !== 1 && type !== 2) continue;
    const joliet = type === 2 && isJoliet(d);
    if (type === 2 && !joliet) continue;
    const id = d.subarray(40, 72);
    const root = { lba: u32(d, 156 + 2), size: u32(d, 156 + 10), label: (joliet ? ucs2be(id) : ascii(id)).trim(), joliet };
    if (joliet) return root;
    primary ??= root;
  }
  if (!primary) throw new Error("not an ISO 9660 disc image");
  return primary;
}

export function readIso(src: FileSource): IsoImage {
  const root = findRoot(src);
  const files: IsoFile[] = [];
  const seen = new Set<number>();

  const walk = (lba: number, size: number, prefix: string): void => {
    if (seen.has(lba)) return;
    seen.add(lba);
    const dir = readBytes(src, lba * SECTOR, size);
    let pos = 0;
    while (pos < dir.length) {
      const len = dir[pos];
      if (len === 0) {
        pos = (Math.floor(pos / SECTOR) + 1) * SECTOR;
        continue;
      }
      const nameLen = dir[pos + 32];
      const raw = dir.subarray(pos + 33, pos + 33 + nameLen);
      const isSelfOrParent = nameLen === 1 && raw[0] <= 1;
      if (!isSelfOrParent) {
        const name = cleanName(root.joliet ? ucs2be(raw) : ascii(raw));
        const extent = u32(dir, pos + 2), extentSize = u32(dir, pos + 10);
        const path = prefix ? `${prefix}\\${name}` : name;
        if (dir[pos + 25] & DIR_FLAG) walk(extent, extentSize, path);
        else files.push({ path, lba: extent, size: extentSize });
      }
      pos += len;
    }
  };

  walk(root.lba, root.size, "");
  return { label: root.label, files };
}

export class IsoFileSource implements FileSource {
  constructor(
    private readonly image: FileSource,
    private readonly file: IsoFile,
  ) {}

  get size(): number {
    return this.file.size;
  }

  read(offset: number, dst: Uint8Array, dstOff: number, len: number): number {
    const n = Math.max(0, Math.min(len, this.file.size - offset));
    return n ? this.image.read(this.file.lba * SECTOR + offset, dst, dstOff, n) : 0;
  }
}
