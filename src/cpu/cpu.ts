import { Memory } from "./memory";
import { FPU } from "./fpu";
import { MMX } from "./mmx";
import { decodeBlock, type Block } from "./decode";
import { HOT, type Jit } from "./jit/jit";
import { ST_FLAGS, ST_SEGBASE, initState } from "./state";

export const CF = 0x1, PF = 0x4, AF = 0x10, ZF = 0x40, SF = 0x80, TF = 0x100, IF = 0x200, DF = 0x400, OF = 0x800;
export const AC = 0x40000, ID = 0x200000;
export const ARITH_FLAGS = CF | PF | AF | ZF | SF | OF;

export const EAX = 0, ECX = 1, EDX = 2, EBX = 3, ESP = 4, EBP = 5, ESI = 6, EDI = 7;
export const ES = 0, CS = 1, SS = 2, DS = 3, FS = 4, GS = 5;

export const LF_NONE = 0, LF_ADD = 1, LF_ADC = 2, LF_SUB = 3, LF_SBB = 4, LF_LOGIC = 5;
export const LF_INC = 6, LF_DEC = 7, LF_NEG = 8, LF_EAGER = 9;

export const MASK = [0, 0xff, 0xffff, 0, 0xffffffff];
export const SIGN = [0, 0x80, 0x8000, 0, 0x80000000];

const PARITY = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let p = 1;
  for (let b = i; b; b >>= 1) p ^= b & 1;
  PARITY[i] = p;
}

export class GuestFault extends Error {
  constructor(
    public kind: "DE" | "UD" | "GP" | "PF" | "BP" | "INT" | "HLT",
    public addr = 0,
    detail = "",
  ) {
    super(`${kind} fault${detail ? ": " + detail : ""}`);
  }
}

export class CPU {
  readonly mem: Memory;
  readonly dv: DataView;
  readonly u8: Uint8Array;
  readonly r: Int32Array;
  /** flags, lfOp, lfA, lfB, lfRes, lfSz, lfCin, lfOf as consecutive u32 in wasm memory. */
  readonly s: Uint32Array;
  eip = 0;

  get flags(): number { return this.s[0]; }
  set flags(v: number) { this.s[0] = v; }
  get lfOp(): number { return this.s[1]; }
  set lfOp(v: number) { this.s[1] = v; }
  get lfA(): number { return this.s[2]; }
  set lfA(v: number) { this.s[2] = v; }
  get lfB(): number { return this.s[3]; }
  set lfB(v: number) { this.s[3] = v; }
  get lfRes(): number { return this.s[4]; }
  set lfRes(v: number) { this.s[4] = v; }
  get lfSz(): number { return this.s[5]; }
  set lfSz(v: number) { this.s[5] = v; }
  get lfCin(): number { return this.s[6]; }
  set lfCin(v: number) { this.s[6] = v; }
  get lfOf(): number { return this.s[7]; }
  set lfOf(v: number) { this.s[7] = v; }

  readonly seg = new Uint16Array(6);
  readonly segBase: Uint32Array;
  readonly fpu: FPU;
  readonly mmx: MMX;

  pages: (Block[] | undefined)[] = [];
  hleBase = 0;
  hleSize = 0;
  onHle: (index: number) => void = () => {
    throw new Error("no HLE handler");
  };
  stopReq = false;
  icount = 0;
  prof: Map<number, number> | null = null;
  tscBase = 0;
  tscHz = 266e6;
  now: () => number = () => performance.now();

  jit: Jit | null = null;
  /** Number of blocks to interpret before entering compiled code again. */
  jitOff = 0;
  curBlock: Block | null = null;
  curIdx = 0;

  constructor(mem: Memory) {
    this.mem = mem;
    this.dv = mem.dv;
    this.u8 = mem.u8;
    initState(mem.u8, mem.stateBase);
    this.r = new Int32Array(mem.buf, mem.stateBase, 8);
    this.s = new Uint32Array(mem.buf, mem.stateBase + ST_FLAGS, 8);
    this.segBase = new Uint32Array(mem.buf, mem.stateBase + ST_SEGBASE, 6);
    this.fpu = new FPU(this);
    this.mmx = new MMX(this);
    this.seg.set([0x23, 0x1b, 0x23, 0x23, 0x3b, 0x00]);
  }

  // ---------- flags ----------

  cf(): number {
    switch (this.lfOp) {
      case LF_NONE: return this.flags & CF;
      case LF_ADD: return this.lfRes < this.lfA ? 1 : 0;
      case LF_ADC: return (this.lfCin ? this.lfRes <= this.lfA : this.lfRes < this.lfA) ? 1 : 0;
      case LF_SUB: return this.lfA < this.lfB ? 1 : 0;
      case LF_SBB: return (this.lfCin ? this.lfA <= this.lfB : this.lfA < this.lfB) ? 1 : 0;
      case LF_LOGIC: return 0;
      case LF_NEG: return this.lfRes !== 0 ? 1 : 0;
      default: return this.lfCin;
    }
  }
  zf(): boolean {
    return this.lfOp === LF_NONE ? (this.flags & ZF) !== 0 : this.lfRes === 0;
  }
  sf(): boolean {
    return this.lfOp === LF_NONE ? (this.flags & SF) !== 0 : (this.lfRes & SIGN[this.lfSz]) !== 0;
  }
  pf(): boolean {
    return this.lfOp === LF_NONE ? (this.flags & PF) !== 0 : PARITY[this.lfRes & 0xff] === 1;
  }
  af(): boolean {
    switch (this.lfOp) {
      case LF_NONE: return (this.flags & AF) !== 0;
      case LF_ADD: case LF_ADC: case LF_SUB: case LF_SBB:
        return ((this.lfA ^ this.lfB ^ this.lfRes) & 0x10) !== 0;
      case LF_INC: return (this.lfRes & 0xf) === 0;
      case LF_DEC: return (this.lfRes & 0xf) === 0xf;
      case LF_NEG: return (this.lfRes & 0xf) !== 0;
      default: return false;
    }
  }
  of(): boolean {
    const s = SIGN[this.lfSz];
    switch (this.lfOp) {
      case LF_NONE: return (this.flags & OF) !== 0;
      case LF_ADD: case LF_ADC: return ((this.lfA ^ this.lfRes) & (this.lfB ^ this.lfRes) & s) !== 0;
      case LF_SUB: case LF_SBB: return ((this.lfA ^ this.lfB) & (this.lfA ^ this.lfRes) & s) !== 0;
      case LF_LOGIC: return false;
      case LF_INC: case LF_NEG: return this.lfRes === s;
      case LF_DEC: return this.lfRes === (s - 1) >>> 0;
      default: return this.lfOf !== 0;
    }
  }

  getFlags(): number {
    if (this.lfOp === LF_NONE) return this.flags;
    let f = this.flags & ~ARITH_FLAGS;
    if (this.cf()) f |= CF;
    if (this.pf()) f |= PF;
    if (this.af()) f |= AF;
    if (this.zf()) f |= ZF;
    if (this.sf()) f |= SF;
    if (this.of()) f |= OF;
    return f;
  }
  materialize(): void {
    if (this.lfOp !== LF_NONE) {
      this.flags = this.getFlags();
      this.lfOp = LF_NONE;
    }
  }
  setFlags(v: number): void {
    this.flags = (v & 0x3f7fd7) | 2;
    this.lfOp = LF_NONE;
  }
  setCF(on: boolean | number): void {
    this.materialize();
    if (on) this.flags |= CF;
    else this.flags &= ~CF;
  }
  /** Sets CF and OF eagerly while keeping ZF/SF/PF lazy from `res`. */
  setEager(res: number, sz: number, cf: number, of: number): void {
    this.lfOp = LF_EAGER;
    this.lfRes = res;
    this.lfSz = sz;
    this.lfCin = cf;
    this.lfOf = of;
    this.lfA = 0;
    this.lfB = 0;
  }

  cond(cc: number): boolean {
    switch (cc) {
      case 0: return this.of();
      case 1: return !this.of();
      case 2: return this.cf() !== 0;
      case 3: return this.cf() === 0;
      case 4: return this.zf();
      case 5: return !this.zf();
      case 6: return this.cf() !== 0 || this.zf();
      case 7: return this.cf() === 0 && !this.zf();
      case 8: return this.sf();
      case 9: return !this.sf();
      case 10: return this.pf();
      case 11: return !this.pf();
      case 12: return this.sf() !== this.of();
      case 13: return this.sf() === this.of();
      case 14: return this.zf() || this.sf() !== this.of();
      default: return !this.zf() && this.sf() === this.of();
    }
  }

  // ---------- ALU ----------

  /** op: 0 add, 1 or, 2 adc, 3 sbb, 4 and, 5 sub, 6 xor, 7 cmp. sz: 1, 2 or 4 bytes. */
  alu(op: number, a: number, b: number, sz: number): number {
    const m = MASK[sz];
    a = (a & m) >>> 0;
    b = (b & m) >>> 0;
    let r: number;
    switch (op) {
      case 0: r = (a + b) & m; this.lfOp = LF_ADD; break;
      case 1: r = a | b; this.lfOp = LF_LOGIC; break;
      case 2: { const c = this.cf(); r = (a + b + c) & m; this.lfCin = c; this.lfOp = LF_ADC; break; }
      case 3: { const c = this.cf(); r = (a - b - c) & m; this.lfCin = c; this.lfOp = LF_SBB; break; }
      case 4: r = a & b; this.lfOp = LF_LOGIC; break;
      case 6: r = a ^ b; this.lfOp = LF_LOGIC; break;
      default: r = (a - b) & m; this.lfOp = LF_SUB; break;
    }
    r = r >>> 0;
    this.lfA = a;
    this.lfB = b;
    this.lfRes = r;
    this.lfSz = sz;
    return op === 7 ? a : r;
  }
  inc(a: number, sz: number): number {
    const m = MASK[sz];
    this.lfCin = this.cf();
    const r = ((a + 1) & m) >>> 0;
    this.lfOp = LF_INC;
    this.lfA = (a & m) >>> 0;
    this.lfB = 1;
    this.lfRes = r;
    this.lfSz = sz;
    return r;
  }
  dec(a: number, sz: number): number {
    const m = MASK[sz];
    this.lfCin = this.cf();
    const r = ((a - 1) & m) >>> 0;
    this.lfOp = LF_DEC;
    this.lfA = (a & m) >>> 0;
    this.lfB = 1;
    this.lfRes = r;
    this.lfSz = sz;
    return r;
  }
  neg(a: number, sz: number): number {
    const m = MASK[sz];
    const b = (a & m) >>> 0;
    const r = ((0 - b) & m) >>> 0;
    this.lfOp = LF_NEG;
    this.lfA = 0;
    this.lfB = b;
    this.lfRes = r;
    this.lfSz = sz;
    return r;
  }
  logic(r: number, sz: number): void {
    this.lfOp = LF_LOGIC;
    this.lfRes = (r & MASK[sz]) >>> 0;
    this.lfSz = sz;
    this.lfA = 0;
    this.lfB = 0;
  }

  /** op: 0 rol, 1 ror, 2 rcl, 3 rcr, 4 shl, 5 shr, 6 sal, 7 sar */
  shift(op: number, a: number, count: number, sz: number): number {
    count &= 31;
    const bits = sz * 8;
    const m = MASK[sz];
    a = (a & m) >>> 0;
    if (count === 0) return a;
    const s = SIGN[sz];
    let r: number;
    switch (op) {
      case 0: {
        const c = count % bits;
        r = c === 0 ? a : ((a << c) | (a >>> (bits - c))) & m;
        r >>>= 0;
        const cfv = r & 1;
        this.preserveAllButCO(cfv, ((r & s) !== 0 ? 1 : 0) ^ cfv);
        return r;
      }
      case 1: {
        const c = count % bits;
        r = c === 0 ? a : ((a >>> c) | (a << (bits - c))) & m;
        r >>>= 0;
        const cfv = (r & s) !== 0 ? 1 : 0;
        const of = cfv ^ ((r & (s >>> 1)) !== 0 ? 1 : 0);
        this.preserveAllButCO(cfv, of);
        return r;
      }
      case 2: {
        const c = count % (bits + 1);
        let cfv = this.cf();
        r = a;
        for (let i = 0; i < c; i++) {
          const out = (r & s) !== 0 ? 1 : 0;
          r = (((r << 1) | cfv) & m) >>> 0;
          cfv = out;
        }
        this.preserveAllButCO(cfv, ((r & s) !== 0 ? 1 : 0) ^ cfv);
        return r;
      }
      case 3: {
        const c = count % (bits + 1);
        let cfv = this.cf();
        r = a;
        const of = ((r & s) !== 0 ? 1 : 0) ^ cfv;
        for (let i = 0; i < c; i++) {
          const out = r & 1;
          r = ((r >>> 1) | (cfv ? s : 0)) >>> 0;
          cfv = out;
        }
        this.preserveAllButCO(cfv, of);
        return r;
      }
      case 4: case 6: {
        r = count < 32 ? ((a << count) & m) >>> 0 : 0;
        const cfv = count <= bits ? (a >>> (bits - count)) & 1 : 0;
        this.setEager(r, sz, cfv, ((r & s) !== 0 ? 1 : 0) ^ cfv);
        return r;
      }
      case 5: {
        r = a >>> count;
        const cfv = (a >>> (count - 1)) & 1;
        this.setEager(r, sz, cfv, count === 1 ? ((a & s) !== 0 ? 1 : 0) : 0);
        return r;
      }
      default: {
        const sa = sz === 4 ? a | 0 : sz === 2 ? (a << 16) >> 16 : (a << 24) >> 24;
        const c = count > bits - 1 ? bits - 1 : count;
        r = ((sa >> c) & m) >>> 0;
        const cfv = count >= bits ? (sa < 0 ? 1 : 0) : (sa >> (count - 1)) & 1;
        this.setEager(r, sz, cfv, 0);
        return r;
      }
    }
  }
  private preserveAllButCO(cfv: number, of: number): void {
    this.materialize();
    this.flags = (this.flags & ~(CF | OF)) | (cfv ? CF : 0) | (of ? OF : 0);
  }

  // ---------- memory helpers ----------

  push32(v: number): void {
    const sp = (this.r[ESP] - 4) >>> 0;
    this.dv.setUint32(sp, v, true);
    this.r[ESP] = sp;
  }
  pop32(): number {
    const sp = this.r[ESP] >>> 0;
    const v = this.dv.getUint32(sp, true);
    this.r[ESP] = sp + 4;
    return v;
  }
  push16(v: number): void {
    const sp = (this.r[ESP] - 2) >>> 0;
    this.dv.setUint16(sp, v, true);
    this.r[ESP] = sp;
  }
  pop16(): number {
    const sp = this.r[ESP] >>> 0;
    const v = this.dv.getUint16(sp, true);
    this.r[ESP] = sp + 2;
    return v;
  }

  get8(i: number): number {
    return i < 4 ? this.r[i] & 0xff : (this.r[i - 4] >> 8) & 0xff;
  }
  set8(i: number, v: number): void {
    if (i < 4) this.r[i] = (this.r[i] & ~0xff) | (v & 0xff);
    else this.r[i - 4] = (this.r[i - 4] & ~0xff00) | ((v & 0xff) << 8);
  }
  get16(i: number): number {
    return this.r[i] & 0xffff;
  }
  set16(i: number, v: number): void {
    this.r[i] = (this.r[i] & ~0xffff) | (v & 0xffff);
  }

  rdtsc(): [number, number] {
    const cycles = (this.now() - this.tscBase) * (this.tscHz / 1000);
    const lo = cycles % 4294967296;
    return [lo >>> 0, Math.floor(cycles / 4294967296) >>> 0];
  }

  // ---------- execution ----------

  invalidate(start: number, len: number): void {
    const p0 = start >>> 12, p1 = (start + len + 0xfff) >>> 12;
    for (let p = p0 - 1; p <= p1; p++) if (p >= 0) this.pages[p] = undefined;
    this.jit?.invalidate(start, len);
  }

  lookup(eip: number): Block {
    const page = eip >>> 12;
    let pg = this.pages[page];
    if (!pg) pg = this.pages[page] = new Array(4096);
    let b = pg[eip & 0xfff];
    if (!b) b = pg[eip & 0xfff] = decodeBlock(this, eip);
    return b;
  }

  /** Runs until `budget` instructions have retired (approximately) or stopReq is set. */
  run(budget: number): void {
    this.stopReq = false;
    const hleBase = this.hleBase, hleSize = this.hleSize;
    while (budget > 0 && !this.stopReq) {
      const eip = this.eip;
      if (((eip - hleBase) >>> 0) < hleSize) {
        this.onHle(((eip - hleBase) >>> 0) >>> 4);
        budget -= 20;
        continue;
      }
      const blk = this.lookup(eip);
      if (blk.jit && this.jitOff === 0) {
        const n = this.jit!.exec(blk.jit, budget);
        budget -= n;
        this.icount += n;
        continue;
      }
      if (this.jitOff > 0) this.jitOff--;
      else if (this.jit && ++blk.hits === HOT) this.jit.compile(eip);
      const insns = blk.insns;
      this.eip = blk.end;
      this.curBlock = blk;
      let i = 0;
      try {
        for (; i < insns.length; i++) insns[i].exec(this);
      } catch (e) {
        this.curIdx = i;
        if (e instanceof GuestFault || e instanceof RangeError) this.eip = insns[i].addr;
        throw e;
      }
      budget -= insns.length;
      this.icount += insns.length;
      if (this.prof) this.prof.set(blk.start, (this.prof.get(blk.start) ?? 0) + insns.length);
    }
  }

  step(): void {
    const eip = this.eip;
    if (((eip - this.hleBase) >>> 0) < this.hleSize) {
      this.onHle(((eip - this.hleBase) >>> 0) >>> 4);
      return;
    }
    const insn = decodeBlock(this, eip, 1).insns[0];
    this.eip = insn.next;
    insn.exec(this);
    this.icount++;
  }
}
