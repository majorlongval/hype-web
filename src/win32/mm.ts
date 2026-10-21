import type { Memory } from "../cpu/memory";

const GRAN = 0x10000;
const PAGE = 0x1000;

interface Region {
  base: number;
  size: number;
  tag: string;
}

/** Address-space bookkeeping. All guest memory is backed; this only tracks who owns which range. */
export class AddressSpace {
  private regions: Region[] = [];
  constructor(
    private lo: number,
    private hi: number,
  ) {}

  isFree(base: number, size: number): boolean {
    const end = base + size;
    if (base < this.lo || end > this.hi) return false;
    return !this.regions.some((r) => base < r.base + r.size && r.base < end);
  }

  reserveAt(base: number, size: number, tag: string): boolean {
    size = roundUp(size, PAGE);
    if (!this.isFree(base, size)) return false;
    this.insert({ base, size, tag });
    return true;
  }

  reserve(size: number, tag: string, align = GRAN, topDown = false): number {
    size = roundUp(size, PAGE);
    const sorted = this.regions;
    if (topDown) {
      let cursor = this.hi;
      for (let i = sorted.length - 1; i >= -1; i--) {
        const gapLo = i >= 0 ? sorted[i].base + sorted[i].size : this.lo;
        const cand = Math.floor((cursor - size) / align) * align;
        if (cand >= gapLo && cand >= this.lo) {
          this.insert({ base: cand, size, tag });
          return cand;
        }
        if (i >= 0) cursor = sorted[i].base;
      }
      return 0;
    }
    let cursor = this.lo;
    for (let i = 0; i <= sorted.length; i++) {
      const gapHi = i < sorted.length ? sorted[i].base : this.hi;
      const cand = roundUp(cursor, align);
      if (cand + size <= gapHi) {
        this.insert({ base: cand, size, tag });
        return cand;
      }
      if (i < sorted.length) cursor = sorted[i].base + sorted[i].size;
    }
    return 0;
  }

  release(base: number): Region | null {
    const i = this.regions.findIndex((r) => r.base === base);
    if (i < 0) return null;
    return this.regions.splice(i, 1)[0];
  }

  find(addr: number): Region | null {
    for (const r of this.regions) if (addr >= r.base && addr < r.base + r.size) return r;
    return null;
  }

  list(): readonly Region[] {
    return this.regions;
  }

  private insert(r: Region): void {
    let i = 0;
    while (i < this.regions.length && this.regions[i].base < r.base) i++;
    this.regions.splice(i, 0, r);
  }
}

export function roundUp(v: number, a: number): number {
  return Math.ceil(v / a) * a;
}

const SMALL_MAX = 4096;
const SEGMENT = 0x100000;

/** A Win32-style heap: size-class free lists for small blocks, first-fit list for large ones. */
export class Heap {
  readonly handle: number;
  private sizes = new Map<number, number>();
  private blockSizes = new Map<number, number>();
  private small: number[][] = [];
  private large: { addr: number; size: number }[] = [];
  private segEnd = 0;
  private segPtr = 0;
  bytesInUse = 0;

  constructor(
    private mem: Memory,
    private as: AddressSpace,
    handle: number,
    readonly name: string,
  ) {
    this.handle = handle;
  }

  alloc(size: number, zero: boolean): number {
    const bs = Math.max(16, roundUp(size || 1, 16));
    let addr = 0;
    if (bs <= SMALL_MAX) {
      const list = this.small[bs >> 4];
      if (list && list.length) addr = list.pop()!;
      else addr = this.bump(bs);
    } else {
      for (let i = 0; i < this.large.length; i++) {
        const b = this.large[i];
        if (b.size >= bs) {
          addr = b.addr;
          if (b.size - bs >= 64) {
            b.addr += bs;
            b.size -= bs;
          } else {
            this.large.splice(i, 1);
            this.blockSizes.set(addr, b.size);
          }
          break;
        }
      }
      if (!addr) {
        if (bs >= SEGMENT / 2) {
          addr = this.as.reserve(bs, `${this.name}:large`);
          if (!addr) return 0;
        } else addr = this.bump(bs);
      }
    }
    if (!addr) return 0;
    if (!this.blockSizes.has(addr)) this.blockSizes.set(addr, bs);
    this.sizes.set(addr, size);
    this.bytesInUse += size;
    if (zero) this.mem.u8.fill(0, addr, addr + bs);
    return addr;
  }

  free(addr: number): boolean {
    const size = this.sizes.get(addr);
    if (size === undefined) return false;
    this.sizes.delete(addr);
    this.bytesInUse -= size;
    const bs = this.blockSizes.get(addr)!;
    if (bs <= SMALL_MAX) {
      (this.small[bs >> 4] ??= []).push(addr);
    } else {
      this.blockSizes.delete(addr);
      this.large.push({ addr, size: bs });
      if (this.large.length > 64) this.coalesce();
    }
    return true;
  }

  realloc(addr: number, size: number, zero: boolean, inPlaceOnly: boolean): number {
    const old = this.sizes.get(addr);
    if (old === undefined) return 0;
    const bs = this.blockSizes.get(addr)!;
    if (size <= bs) {
      if (zero && size > old) this.mem.u8.fill(0, addr + old, addr + size);
      this.bytesInUse += size - old;
      this.sizes.set(addr, size);
      return addr;
    }
    if (inPlaceOnly) return 0;
    const n = this.alloc(size, false);
    if (!n) return 0;
    this.mem.u8.copyWithin(n, addr, addr + old);
    if (zero) this.mem.u8.fill(0, n + old, n + size);
    this.free(addr);
    return n;
  }

  size(addr: number): number {
    return this.sizes.get(addr) ?? -1;
  }

  owns(addr: number): boolean {
    return this.sizes.has(addr);
  }

  private bump(bs: number): number {
    if (this.segPtr + bs > this.segEnd) {
      const seg = this.as.reserve(SEGMENT, `${this.name}:seg`);
      if (!seg) return 0;
      this.segPtr = seg;
      this.segEnd = seg + SEGMENT;
    }
    const a = this.segPtr;
    this.segPtr += bs;
    return a;
  }

  private coalesce(): void {
    this.large.sort((a, b) => a.addr - b.addr);
    const out: { addr: number; size: number }[] = [];
    for (const b of this.large) {
      const last = out[out.length - 1];
      if (last && last.addr + last.size === b.addr) last.size += b.size;
      else out.push({ ...b });
    }
    this.large = out;
  }
}
