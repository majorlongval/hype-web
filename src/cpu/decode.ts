import {
  CPU, GuestFault, CF, DF, ZF, ESP, EBP, EAX, ECX, EDX, EBX, ESI, EDI, FS, GS, MASK, SIGN, LF_NONE,
} from "./cpu";

export type Exec = (c: CPU) => void;
export interface Insn {
  addr: number;
  len: number;
  next: number;
  exec: Exec;
  flow: boolean;
}
export interface Block {
  start: number;
  end: number;
  insns: Insn[];
}

type EA = (c: CPU) => number;
type Rd = (c: CPU) => number;
type Wr = (c: CPU, v: number) => void;

interface ModRM {
  mod: number;
  reg: number;
  rm: number;
  ea: EA | null;
  lea: EA | null;
}

class Dec {
  p: number;
  start: number;
  opsz = 4;
  adsz = 4;
  seg = -1;
  rep = 0;
  constructor(public dv: DataView, addr: number) {
    this.p = addr;
    this.start = addr;
  }
  u8(): number {
    return this.dv.getUint8(this.p++);
  }
  s8(): number {
    const v = this.dv.getInt8(this.p);
    this.p++;
    return v;
  }
  u16(): number {
    const v = this.dv.getUint16(this.p, true);
    this.p += 2;
    return v;
  }
  s16(): number {
    const v = this.dv.getInt16(this.p, true);
    this.p += 2;
    return v;
  }
  u32(): number {
    const v = this.dv.getUint32(this.p, true);
    this.p += 4;
    return v;
  }
  s32(): number {
    const v = this.dv.getInt32(this.p, true);
    this.p += 4;
    return v;
  }
  imm(sz: number): number {
    return sz === 1 ? this.u8() : sz === 2 ? this.u16() : this.u32();
  }
  /** Immediate sign-extended then masked to `sz`. */
  immS8(sz: number): number {
    return (this.s8() & MASK[sz]) >>> 0;
  }
}

// ---------- memory access by size ----------

const LD: ((c: CPU, a: number) => number)[] = [
  () => 0,
  (c, a) => c.dv.getUint8(a),
  (c, a) => c.dv.getUint16(a, true),
  () => 0,
  (c, a) => c.dv.getUint32(a, true),
];
const ST: ((c: CPU, a: number, v: number) => void)[] = [
  () => {},
  (c, a, v) => c.dv.setUint8(a, v),
  (c, a, v) => c.dv.setUint16(a, v, true),
  () => {},
  (c, a, v) => c.dv.setUint32(a, v, true),
];

function regRd(reg: number, sz: number): Rd {
  if (sz === 4) return (c) => c.r[reg] >>> 0;
  if (sz === 2) return (c) => c.r[reg] & 0xffff;
  if (reg < 4) return (c) => c.r[reg] & 0xff;
  const r = reg - 4;
  return (c) => (c.r[r] >> 8) & 0xff;
}
function regWr(reg: number, sz: number): Wr {
  if (sz === 4) return (c, v) => { c.r[reg] = v; };
  if (sz === 2) return (c, v) => { c.r[reg] = (c.r[reg] & ~0xffff) | (v & 0xffff); };
  if (reg < 4) return (c, v) => { c.r[reg] = (c.r[reg] & ~0xff) | (v & 0xff); };
  const r = reg - 4;
  return (c, v) => { c.r[r] = (c.r[r] & ~0xff00) | ((v & 0xff) << 8); };
}

function rmRd(m: ModRM, sz: number): Rd {
  if (!m.ea) return regRd(m.rm, sz);
  const ea = m.ea, ld = LD[sz];
  if (sz === 4) return (c) => c.dv.getUint32(ea(c), true);
  return (c) => ld(c, ea(c));
}
function rmWr(m: ModRM, sz: number): Wr {
  if (!m.ea) return regWr(m.rm, sz);
  const ea = m.ea, st = ST[sz];
  if (sz === 4) return (c, v) => c.dv.setUint32(ea(c), v, true);
  return (c, v) => st(c, ea(c), v);
}
/** Read-modify-write on the r/m operand. */
function rmw(m: ModRM, sz: number, f: (c: CPU, v: number) => number): Exec {
  if (!m.ea) {
    const rd = regRd(m.rm, sz), wr = regWr(m.rm, sz);
    return (c) => wr(c, f(c, rd(c)));
  }
  const ea = m.ea, ld = LD[sz], st = ST[sz];
  return (c) => {
    const a = ea(c);
    st(c, a, f(c, ld(c, a)));
  };
}

function makeEA(base: number, index: number, scale: number, disp: number, seg: number): EA {
  let ea: EA;
  if (base < 0 && index < 0) {
    const a = disp >>> 0;
    ea = () => a;
  } else if (index < 0) {
    ea = disp === 0 ? (c) => c.r[base] >>> 0 : (c) => (c.r[base] + disp) >>> 0;
  } else if (base < 0) {
    ea = (c) => ((c.r[index] << scale) + disp) >>> 0;
  } else if (disp === 0) {
    ea = (c) => (c.r[base] + (c.r[index] << scale)) >>> 0;
  } else {
    ea = (c) => (c.r[base] + (c.r[index] << scale) + disp) >>> 0;
  }
  if (seg === FS || seg === GS) {
    const inner = ea, s = seg;
    return (c) => (inner(c) + c.segBase[s]) >>> 0;
  }
  return ea;
}

function makeEA16(rm: number, mod: number, disp: number, seg: number): EA {
  const pairs: [number, number][] = [
    [EBX, ESI], [EBX, EDI], [EBP, ESI], [EBP, EDI], [ESI, -1], [EDI, -1], [EBP, -1], [EBX, -1],
  ];
  let [b, i] = pairs[rm];
  if (mod === 0 && rm === 6) b = -1;
  const sb = seg === FS || seg === GS ? seg : -1;
  return (c) => {
    let a = disp;
    if (b >= 0) a += c.r[b];
    if (i >= 0) a += c.r[i];
    return ((a & 0xffff) + (sb >= 0 ? c.segBase[sb] : 0)) >>> 0;
  };
}

function modrm(d: Dec): ModRM {
  const b = d.u8();
  const mod = b >> 6, reg = (b >> 3) & 7, rm = b & 7;
  if (mod === 3) return { mod, reg, rm, ea: null, lea: null };
  if (d.adsz === 2) {
    let disp = 0;
    if (mod === 0 && rm === 6) disp = d.s16();
    else if (mod === 1) disp = d.s8();
    else if (mod === 2) disp = d.s16();
    return { mod, reg, rm, ea: makeEA16(rm, mod, disp, d.seg), lea: makeEA16(rm, mod, disp, -1) };
  }
  let base = -1, index = -1, scale = 0, disp = 0;
  if (rm === 4) {
    const sib = d.u8();
    scale = sib >> 6;
    index = (sib >> 3) & 7;
    base = sib & 7;
    if (index === 4) index = -1;
    if (base === 5 && mod === 0) {
      base = -1;
      disp = d.s32();
    }
  } else if (rm === 5 && mod === 0) {
    disp = d.s32();
  } else {
    base = rm;
  }
  if (mod === 1) disp = d.s8();
  else if (mod === 2) disp = d.s32();
  return { mod, reg, rm, ea: makeEA(base, index, scale, disp, d.seg), lea: makeEA(base, index, scale, disp, -1) };
}

function ud(d: Dec, what: string): Exec {
  const at = d.start;
  return () => {
    throw new GuestFault("UD", at, what);
  };
}

const sx8 = (v: number) => (v << 24) >> 24;
const sx16 = (v: number) => (v << 16) >> 16;

// ---------- multiply / divide ----------

function mulU32(a: number, b: number): [number, number] {
  const a0 = a & 0xffff, a1 = a >>> 16, b0 = b & 0xffff, b1 = b >>> 16;
  const p00 = a0 * b0, p01 = a0 * b1, p10 = a1 * b0, p11 = a1 * b1;
  const mid = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff);
  const lo = (((mid & 0xffff) << 16) | (p00 & 0xffff)) >>> 0;
  const hi = (p11 + (p01 >>> 16) + (p10 >>> 16) + (mid >>> 16)) >>> 0;
  return [lo, hi];
}

function grp3(c: CPU, op: number, v: number, sz: number, wr: Wr): void {
  switch (op) {
    case 2: wr(c, ~v); return;
    case 3: wr(c, c.neg(v, sz)); return;
    case 4: {
      if (sz === 1) {
        const r = (c.r[EAX] & 0xff) * v;
        c.set16(EAX, r);
        const o = r > 0xff ? 1 : 0;
        c.setEager(r & 0xff, 1, o, o);
      } else if (sz === 2) {
        const r = (c.r[EAX] & 0xffff) * v;
        c.set16(EAX, r);
        c.set16(EDX, r >>> 16);
        const o = r > 0xffff ? 1 : 0;
        c.setEager(r & 0xffff, 2, o, o);
      } else {
        const [lo, hi] = mulU32(c.r[EAX] >>> 0, v);
        c.r[EAX] = lo;
        c.r[EDX] = hi;
        const o = hi !== 0 ? 1 : 0;
        c.setEager(lo, 4, o, o);
      }
      return;
    }
    case 5: {
      if (sz === 1) {
        const r = sx8(c.r[EAX]) * sx8(v);
        c.set16(EAX, r);
        const o = r !== sx8(r) ? 1 : 0;
        c.setEager(r & 0xff, 1, o, o);
      } else if (sz === 2) {
        const r = sx16(c.r[EAX]) * sx16(v);
        c.set16(EAX, r);
        c.set16(EDX, r >> 16);
        const o = r !== sx16(r) ? 1 : 0;
        c.setEager(r & 0xffff, 2, o, o);
      } else {
        const a = c.r[EAX], b = v | 0;
        let [lo, hi] = mulU32(a >>> 0, b >>> 0);
        if (a < 0) hi = (hi - (b >>> 0)) >>> 0;
        if (b < 0) hi = (hi - (a >>> 0)) >>> 0;
        c.r[EAX] = lo;
        c.r[EDX] = hi;
        const o = (hi | 0) !== (lo | 0) >> 31 ? 1 : 0;
        c.setEager(lo, 4, o, o);
      }
      return;
    }
    case 6: {
      if (v === 0) throw new GuestFault("DE", c.eip);
      if (sz === 1) {
        const a = c.r[EAX] & 0xffff;
        const q = Math.floor(a / v);
        if (q > 0xff) throw new GuestFault("DE", c.eip);
        c.set16(EAX, ((a % v) << 8) | q);
      } else if (sz === 2) {
        const a = ((c.r[EDX] & 0xffff) * 65536) + (c.r[EAX] & 0xffff);
        const q = Math.floor(a / v);
        if (q > 0xffff) throw new GuestFault("DE", c.eip);
        c.set16(EAX, q);
        c.set16(EDX, a % v);
      } else {
        const hi = c.r[EDX] >>> 0, lo = c.r[EAX] >>> 0;
        if (hi === 0) {
          c.r[EAX] = Math.floor(lo / v);
          c.r[EDX] = lo % v;
        } else {
          if (hi >= v) throw new GuestFault("DE", c.eip);
          const n = (BigInt(hi) << 32n) | BigInt(lo);
          const bv = BigInt(v);
          c.r[EAX] = Number(n / bv);
          c.r[EDX] = Number(n % bv);
        }
      }
      return;
    }
    default: {
      if (v === 0) throw new GuestFault("DE", c.eip);
      if (sz === 1) {
        const a = sx16(c.r[EAX]), b = sx8(v);
        const q = Math.trunc(a / b);
        if (q > 127 || q < -128) throw new GuestFault("DE", c.eip);
        c.set16(EAX, (((a % b) & 0xff) << 8) | (q & 0xff));
      } else if (sz === 2) {
        const a = ((c.r[EDX] << 16) | (c.r[EAX] & 0xffff)), b = sx16(v);
        const q = Math.trunc(a / b);
        if (q > 32767 || q < -32768) throw new GuestFault("DE", c.eip);
        c.set16(EAX, q);
        c.set16(EDX, a % b);
      } else {
        const hi = c.r[EDX], lo = c.r[EAX], b = v | 0;
        if (hi === lo >> 31) {
          if (lo === -2147483648 && b === -1) throw new GuestFault("DE", c.eip);
          c.r[EAX] = Math.trunc(lo / b);
          c.r[EDX] = lo % b;
        } else {
          const n = (BigInt(hi) << 32n) | BigInt(lo >>> 0);
          const bb = BigInt(b);
          const q = n / bb;
          if (q > 2147483647n || q < -2147483648n) throw new GuestFault("DE", c.eip);
          c.r[EAX] = Number(q);
          c.r[EDX] = Number(n % bb);
        }
      }
    }
  }
}

function imul(c: CPU, a: number, b: number, sz: number): number {
  if (sz === 2) {
    const r = sx16(a) * sx16(b);
    const o = r !== sx16(r) ? 1 : 0;
    c.setEager(r & 0xffff, 2, o, o);
    return r & 0xffff;
  }
  const p = (a | 0) * (b | 0);
  const lo = Math.imul(a, b);
  const o = p > 2147483647 || p < -2147483648 ? 1 : 0;
  c.setEager(lo >>> 0, 4, o, o);
  return lo >>> 0;
}

// ---------- string instructions ----------

function stringOp(d: Dec, opc: number): Exec {
  const sz = opc & 1 ? d.opsz : 1;
  const rep = d.rep;
  const srcSeg = d.seg === FS || d.seg === GS ? d.seg : -1;
  const ld = LD[sz], st = ST[sz];
  if (d.adsz !== 4) return ud(d, "16-bit string op");
  const kind = opc & 0xfe;
  const src = (c: CPU) => (srcSeg >= 0 ? (c.r[ESI] + c.segBase[srcSeg]) >>> 0 : c.r[ESI] >>> 0);
  switch (kind) {
    case 0xa4:
      return (c) => {
        const step = c.flags & DF ? -sz : sz;
        if (!rep) {
          st(c, c.r[EDI] >>> 0, ld(c, src(c)));
          c.r[ESI] += step;
          c.r[EDI] += step;
          return;
        }
        let n = c.r[ECX] >>> 0;
        if (n === 0) return;
        const s = src(c), dd = c.r[EDI] >>> 0, bytes = n * sz;
        if (step > 0 && srcSeg < 0 && (dd <= s || dd >= s + bytes)) {
          if (s + bytes > c.u8.length || dd + bytes > c.u8.length) throw new RangeError("rep movs out of range");
          c.u8.copyWithin(dd, s, s + bytes);
          c.r[ESI] = s + bytes;
          c.r[EDI] = dd + bytes;
          c.r[ECX] = 0;
          return;
        }
        while (n !== 0) {
          st(c, c.r[EDI] >>> 0, ld(c, src(c)));
          c.r[ESI] += step;
          c.r[EDI] += step;
          n--;
        }
        c.r[ECX] = 0;
      };
    case 0xaa:
      return (c) => {
        const step = c.flags & DF ? -sz : sz;
        const v = c.r[EAX] & MASK[sz];
        if (!rep) {
          st(c, c.r[EDI] >>> 0, v);
          c.r[EDI] += step;
          return;
        }
        let n = c.r[ECX] >>> 0;
        if (n === 0) return;
        const dd = c.r[EDI] >>> 0, bytes = n * sz;
        const b0 = v & 0xff;
        const uniform = sz === 1 || (sz === 2 ? v === b0 * 0x101 : v >>> 0 === (b0 * 0x01010101) >>> 0);
        if (step > 0 && uniform) {
          if (dd + bytes > c.u8.length) throw new RangeError("rep stos out of range");
          c.u8.fill(b0, dd, dd + bytes);
          c.r[EDI] = dd + bytes;
          c.r[ECX] = 0;
          return;
        }
        while (n !== 0) {
          st(c, c.r[EDI] >>> 0, v);
          c.r[EDI] += step;
          n--;
        }
        c.r[ECX] = 0;
      };
    case 0xac: {
      const wr = regWr(EAX, sz);
      return (c) => {
        const step = c.flags & DF ? -sz : sz;
        if (!rep) {
          wr(c, ld(c, src(c)));
          c.r[ESI] += step;
          return;
        }
        let n = c.r[ECX] >>> 0;
        while (n !== 0) {
          wr(c, ld(c, src(c)));
          c.r[ESI] += step;
          n--;
        }
        c.r[ECX] = 0;
      };
    }
    case 0xa6:
      return (c) => {
        const step = c.flags & DF ? -sz : sz;
        if (!rep) {
          c.alu(7, ld(c, src(c)), ld(c, c.r[EDI] >>> 0), sz);
          c.r[ESI] += step;
          c.r[EDI] += step;
          return;
        }
        let n = c.r[ECX] >>> 0;
        while (n !== 0) {
          c.alu(7, ld(c, src(c)), ld(c, c.r[EDI] >>> 0), sz);
          c.r[ESI] += step;
          c.r[EDI] += step;
          n--;
          if (rep === 0xf3 ? !c.zf() : c.zf()) break;
        }
        c.r[ECX] = n;
      };
    default:
      return (c) => {
        const step = c.flags & DF ? -sz : sz;
        const a = c.r[EAX] & MASK[sz];
        if (!rep) {
          c.alu(7, a, ld(c, c.r[EDI] >>> 0), sz);
          c.r[EDI] += step;
          return;
        }
        let n = c.r[ECX] >>> 0;
        while (n !== 0) {
          c.alu(7, a, ld(c, c.r[EDI] >>> 0), sz);
          c.r[EDI] += step;
          n--;
          if (rep === 0xf3 ? !c.zf() : c.zf()) break;
        }
        c.r[ECX] = n;
      };
  }
}

// ---------- bit test ----------

function bitOp(m: ModRM, sz: number, op: number, offset: (c: CPU) => number, isImm: boolean): Exec {
  const bits = sz * 8;
  const apply = (c: CPU, v: number, bit: number): number => {
    const mask = 1 << bit;
    c.setCF((v & mask) !== 0);
    if (op === 0) return v;
    if (op === 1) return v | mask;
    if (op === 2) return v & ~mask;
    return v ^ mask;
  };
  if (!m.ea || isImm) {
    if (!m.ea) {
      const rd = regRd(m.rm, sz), wr = regWr(m.rm, sz);
      return (c) => {
        const r = apply(c, rd(c), offset(c) & (bits - 1));
        if (op !== 0) wr(c, r);
      };
    }
    const ea = m.ea, ld = LD[sz], st = ST[sz];
    return (c) => {
      const a = ea(c);
      const r = apply(c, ld(c, a), offset(c) & (bits - 1));
      if (op !== 0) st(c, a, r);
    };
  }
  const ea = m.ea, ld = LD[sz], st = ST[sz];
  return (c) => {
    const off = sz === 4 ? offset(c) | 0 : sx16(offset(c));
    const a = (ea(c) + Math.floor(off / bits) * sz) >>> 0;
    const bit = ((off % bits) + bits) % bits;
    const r = apply(c, ld(c, a), bit);
    if (op !== 0) st(c, a, r);
  };
}

function shiftD(c: CPU, dst: number, src: number, count: number, sz: number, left: boolean): number {
  count &= 31;
  if (count === 0) return dst;
  const bits = sz * 8;
  if (sz === 2 && count > 16) return dst;
  let r: number, cfv: number;
  if (sz === 4) {
    if (left) {
      r = ((dst << count) | (src >>> (32 - count))) >>> 0;
      cfv = (dst >>> (32 - count)) & 1;
    } else {
      r = ((dst >>> count) | (src << (32 - count))) >>> 0;
      cfv = (dst >>> (count - 1)) & 1;
    }
  } else {
    const comb = left ? ((dst & 0xffff) * 65536 + (src & 0xffff)) : ((src & 0xffff) * 65536 + (dst & 0xffff));
    if (left) {
      r = ((comb * Math.pow(2, count)) / 65536) & 0xffff;
      cfv = Math.floor((dst & 0xffff) / Math.pow(2, 16 - count)) & 1;
    } else {
      r = Math.floor(comb / Math.pow(2, count)) & 0xffff;
      cfv = Math.floor((dst & 0xffff) / Math.pow(2, count - 1)) & 1;
    }
  }
  const s = SIGN[sz];
  const of = ((r ^ dst) & s) !== 0 ? 1 : 0;
  c.setEager(r & MASK[sz], sz, cfv, of);
  void bits;
  return r;
}

// ---------- FPU ----------

function fpuOp(d: Dec, opc: number): Exec {
  const m = modrm(d);
  const op = m.reg;
  if (m.ea) {
    const ea = m.ea;
    switch (opc) {
      case 0xd8: return (c) => c.fpu.arith(op, c.fpu.readF32(ea(c)));
      case 0xda: return (c) => c.fpu.arith(op, c.dv.getInt32(ea(c), true));
      case 0xdc: return (c) => c.fpu.arith(op, c.fpu.readF64(ea(c)));
      case 0xde: return (c) => c.fpu.arith(op, c.dv.getInt16(ea(c), true));
      case 0xd9:
        switch (op) {
          case 0: return (c) => c.fpu.push(c.fpu.readF32(ea(c)));
          case 2: return (c) => c.fpu.writeF32(ea(c), c.fpu.get(0));
          case 3: return (c) => { c.fpu.writeF32(ea(c), c.fpu.get(0)); c.fpu.pop(); };
          case 4: return (c) => c.fpu.loadEnv(ea(c));
          case 5: return (c) => { c.fpu.cw = c.dv.getUint16(ea(c), true); };
          case 6: return (c) => c.fpu.storeEnv(ea(c));
          case 7: return (c) => c.dv.setUint16(ea(c), c.fpu.cw, true);
        }
        break;
      case 0xdb:
        switch (op) {
          case 0: return (c) => c.fpu.push(c.dv.getInt32(ea(c), true));
          case 2: return (c) => c.dv.setInt32(ea(c), c.fpu.toInt(c.fpu.get(0), 32), true);
          case 3: return (c) => { c.dv.setInt32(ea(c), c.fpu.toInt(c.fpu.get(0), 32), true); c.fpu.pop(); };
          case 5: return (c) => c.fpu.push(c.fpu.readF80(ea(c)));
          case 7: return (c) => { c.fpu.writeF80(ea(c), c.fpu.get(0)); c.fpu.pop(); };
        }
        break;
      case 0xdd:
        switch (op) {
          case 0: return (c) => c.fpu.push(c.fpu.readF64(ea(c)));
          case 2: return (c) => c.fpu.writeF64(ea(c), c.fpu.get(0));
          case 3: return (c) => { c.fpu.writeF64(ea(c), c.fpu.get(0)); c.fpu.pop(); };
          case 4: return (c) => c.fpu.restore(ea(c));
          case 6: return (c) => c.fpu.save(ea(c));
          case 7: return (c) => c.dv.setUint16(ea(c), c.fpu.getSW(), true);
        }
        break;
      case 0xdf:
        switch (op) {
          case 0: return (c) => c.fpu.push(c.dv.getInt16(ea(c), true));
          case 2: return (c) => c.dv.setUint16(ea(c), c.fpu.toInt(c.fpu.get(0), 16), true);
          case 3: return (c) => { c.dv.setUint16(ea(c), c.fpu.toInt(c.fpu.get(0), 16), true); c.fpu.pop(); };
          case 4: return (c) => c.fpu.push(c.fpu.readBCD(ea(c)));
          case 5: return (c) => c.fpu.push(c.fpu.readI64(ea(c)));
          case 6: return (c) => { c.fpu.writeBCD(ea(c), c.fpu.get(0)); c.fpu.pop(); };
          case 7: return (c) => { c.fpu.writeI64(ea(c), c.fpu.toInt(c.fpu.get(0), 64)); c.fpu.pop(); };
        }
        break;
    }
    return ud(d, `fpu ${opc.toString(16)} /${op}`);
  }
  const i = m.rm;
  const byte = 0xc0 | (op << 3) | i;
  switch (opc) {
    case 0xd8: return (c) => c.fpu.arith(op, c.fpu.get(i));
    case 0xd9:
      if (op === 0) return (c) => { const v = c.fpu.get(i); c.fpu.push(v); };
      if (op === 1 || op === 3) return (c) => {
        if (op === 3) { c.fpu.set(i, c.fpu.get(0)); c.fpu.pop(); return; }
        const t = c.fpu.get(0); c.fpu.set(0, c.fpu.get(i)); c.fpu.set(i, t);
      };
      return (c) => c.fpu.special(byte);
    case 0xda:
      if (byte === 0xe9) return (c) => { c.fpu.compare(c.fpu.get(0), c.fpu.get(1)); c.fpu.pop(); c.fpu.pop(); };
      if (op < 4) {
        const cc = [2, 4, 6, 10][op];
        return (c) => { if (c.cond(cc)) c.fpu.set(0, c.fpu.get(i)); };
      }
      break;
    case 0xdb:
      if (byte === 0xe2) return (c) => { c.fpu.sw &= 0x7f00; };
      if (byte === 0xe3) return (c) => c.fpu.reset();
      if (byte === 0xe0 || byte === 0xe1 || byte === 0xe4) return () => {};
      if (op < 4) {
        const cc = [3, 5, 7, 11][op];
        return (c) => { if (c.cond(cc)) c.fpu.set(0, c.fpu.get(i)); };
      }
      if (op === 5 || op === 6) return (c) => c.fpu.compareFlags(c.fpu.get(0), c.fpu.get(i));
      break;
    case 0xdc: return (c) => c.fpu.arithTo(op, i, false);
    case 0xdd:
      switch (op) {
        case 0: return (c) => { c.fpu.empty[(c.fpu.top + i) & 7] = 1; };
        case 1: return (c) => { const t = c.fpu.get(0); c.fpu.set(0, c.fpu.get(i)); c.fpu.set(i, t); };
        case 2: return (c) => c.fpu.set(i, c.fpu.get(0));
        case 3: return (c) => { c.fpu.set(i, c.fpu.get(0)); c.fpu.pop(); };
        case 4: return (c) => c.fpu.compare(c.fpu.get(0), c.fpu.get(i));
        case 5: return (c) => { c.fpu.compare(c.fpu.get(0), c.fpu.get(i)); c.fpu.pop(); };
      }
      break;
    case 0xde:
      if (op === 3) {
        if (i === 1) return (c) => { c.fpu.compare(c.fpu.get(0), c.fpu.get(1)); c.fpu.pop(); c.fpu.pop(); };
        break;
      }
      return (c) => c.fpu.arithTo(op, i, true);
    case 0xdf:
      if (byte === 0xe0) return (c) => c.set16(EAX, c.fpu.getSW());
      if (op === 0) return (c) => { c.fpu.empty[(c.fpu.top + i) & 7] = 1; c.fpu.pop(); };
      if (op === 5 || op === 6) return (c) => { c.fpu.compareFlags(c.fpu.get(0), c.fpu.get(i)); c.fpu.pop(); };
      break;
  }
  return ud(d, `fpu ${opc.toString(16)} ${byte.toString(16)}`);
}

// ---------- MMX ----------

function mmxOp(d: Dec, opc: number): Exec {
  if (d.opsz === 2) return ud(d, "SSE2 integer op");
  const m = modrm(d);
  const dst = m.reg;
  switch (opc) {
    case 0x6e: {
      const rd = rmRd(m, 4);
      return (c) => { c.mmx.enter(); c.mmx.d[dst * 2] = rd(c); c.mmx.d[dst * 2 + 1] = 0; };
    }
    case 0x7e: {
      const wr = rmWr(m, 4);
      return (c) => { c.mmx.enter(); wr(c, c.mmx.d[dst * 2]); };
    }
    case 0x6f: {
      if (!m.ea) { const s = m.rm; return (c) => { c.mmx.enter(); c.mmx.copy(dst, s); }; }
      const ea = m.ea;
      return (c) => { c.mmx.enter(); c.mmx.load64(dst, ea(c)); };
    }
    case 0x7f: {
      if (!m.ea) { const s = m.rm; return (c) => { c.mmx.enter(); c.mmx.copy(s, dst); }; }
      const ea = m.ea;
      return (c) => { c.mmx.enter(); c.mmx.store64(dst, ea(c)); };
    }
    case 0x71: case 0x72: case 0x73: {
      if (m.ea) return ud(d, "mmx shift imm mem");
      const n = d.u8(), r = m.rm, kind = m.reg === 2 ? 0 : m.reg === 4 ? 1 : m.reg === 6 ? 2 : -1;
      if (kind < 0 || (opc === 0x73 && kind === 1)) return ud(d, "mmx shift group");
      if (opc === 0x71) return (c) => { c.mmx.enter(); c.mmx.shiftW(r, n, kind); };
      if (opc === 0x72) return (c) => { c.mmx.enter(); c.mmx.shiftD(r, n, kind); };
      return (c) => { c.mmx.enter(); c.mmx.shiftQ(r, n, kind); };
    }
  }
  if (!m.ea) {
    const s = m.rm;
    return (c) => c.mmx.op(opc, dst, s);
  }
  const ea = m.ea;
  return (c) => {
    c.mmx.load64(8, ea(c));
    c.mmx.op(opc, dst, 8);
  };
}

// ---------- main decoder ----------

function decodeOne(c: CPU, d: Dec): { exec: Exec; flow: boolean } {
  let opc: number;
  for (;;) {
    opc = d.u8();
    switch (opc) {
      case 0x66: d.opsz = 2; continue;
      case 0x67: d.adsz = 2; continue;
      case 0xf2: case 0xf3: d.rep = opc; continue;
      case 0xf0: continue;
      case 0x26: d.seg = 0; continue;
      case 0x2e: d.seg = 1; continue;
      case 0x36: d.seg = 2; continue;
      case 0x3e: d.seg = 3; continue;
      case 0x64: d.seg = 4; continue;
      case 0x65: d.seg = 5; continue;
    }
    break;
  }
  const osz = d.opsz;
  const N = (exec: Exec) => ({ exec, flow: false });
  const F = (exec: Exec) => ({ exec, flow: true });

  if (opc < 0x40 && (opc & 7) < 6) {
    const op = (opc >> 3) & 7;
    const form = opc & 7;
    const sz = form & 1 ? osz : 1;
    if (form < 2) {
      const m = modrm(d);
      const src = regRd(m.reg, sz);
      if (op === 7) {
        const rd = rmRd(m, sz);
        return N((c) => { c.alu(7, rd(c), src(c), sz); });
      }
      if ((op === 6 || op === 5) && !m.ea && m.rm === m.reg) {
        const wr = regWr(m.rm, sz);
        return N((c) => { wr(c, 0); c.alu(op, 0, 0, sz); });
      }
      return N(rmw(m, sz, (c, v) => c.alu(op, v, src(c), sz)));
    }
    if (form < 4) {
      const m = modrm(d);
      const src = rmRd(m, sz), rd = regRd(m.reg, sz), wr = regWr(m.reg, sz);
      if (op === 7) return N((c) => { c.alu(7, rd(c), src(c), sz); });
      return N((c) => wr(c, c.alu(op, rd(c), src(c), sz)));
    }
    const imm = d.imm(sz);
    const rd = regRd(EAX, sz), wr = regWr(EAX, sz);
    if (op === 7) return N((c) => { c.alu(7, rd(c), imm, sz); });
    return N((c) => wr(c, c.alu(op, rd(c), imm, sz)));
  }

  switch (opc) {
    case 0x06: case 0x0e: case 0x16: case 0x1e: {
      const s = opc >> 3;
      return N((c) => c.push32(c.seg[s]));
    }
    case 0x07: case 0x17: case 0x1f: {
      const s = opc >> 3;
      return N((c) => { c.seg[s] = c.pop32(); });
    }
    case 0x27: return N(daa);
    case 0x2f: return N(das);
    case 0x37: return N(aaa);
    case 0x3f: return N(aas);
    case 0x0f: return decode0F(c, d);
  }

  if (opc >= 0x40 && opc <= 0x4f) {
    const r = opc & 7, rd = regRd(r, osz), wr = regWr(r, osz);
    if (opc < 0x48) return N((c) => wr(c, c.inc(rd(c), osz)));
    return N((c) => wr(c, c.dec(rd(c), osz)));
  }
  if (opc >= 0x50 && opc <= 0x57) {
    const r = opc & 7;
    if (osz === 2) return N((c) => c.push16(c.r[r]));
    return N((c) => c.push32(c.r[r]));
  }
  if (opc >= 0x58 && opc <= 0x5f) {
    const r = opc & 7;
    if (osz === 2) return N((c) => { const v = c.pop16(); c.set16(r, v); });
    return N((c) => { c.r[r] = c.pop32(); });
  }
  if (opc >= 0x70 && opc <= 0x7f) {
    const rel = d.s8();
    const target = (d.p + rel) >>> 0, cc = opc & 15;
    return F((c) => { if (c.cond(cc)) c.eip = target; });
  }
  if (opc >= 0x91 && opc <= 0x97) {
    const r = opc & 7, rd = regRd(r, osz), wr = regWr(r, osz), ra = regRd(EAX, osz), wa = regWr(EAX, osz);
    return N((c) => { const t = rd(c); wr(c, ra(c)); wa(c, t); });
  }
  if (opc >= 0xb0 && opc <= 0xb7) {
    const v = d.u8(), wr = regWr(opc & 7, 1);
    return N((c) => wr(c, v));
  }
  if (opc >= 0xb8 && opc <= 0xbf) {
    const v = d.imm(osz), wr = regWr(opc & 7, osz);
    return N((c) => wr(c, v));
  }
  if (opc >= 0xd8 && opc <= 0xdf) return N(fpuOp(d, opc));

  switch (opc) {
    case 0x60:
      return N((c) => {
        const sp = c.r[ESP];
        for (let i = 0; i < 8; i++) c.push32(i === ESP ? sp : c.r[i]);
      });
    case 0x61:
      return N((c) => {
        for (let i = 7; i >= 0; i--) {
          const v = c.pop32();
          if (i !== ESP) c.r[i] = v;
        }
      });
    case 0x68: {
      const v = d.imm(osz);
      return N(osz === 2 ? (c) => c.push16(v) : (c) => c.push32(v));
    }
    case 0x6a: {
      const v = d.s8();
      return N(osz === 2 ? (c) => c.push16(v) : (c) => c.push32(v));
    }
    case 0x69: case 0x6b: {
      const m = modrm(d);
      const src = rmRd(m, osz), wr = regWr(m.reg, osz);
      const imm = opc === 0x6b ? d.immS8(osz) : d.imm(osz);
      return N((c) => wr(c, imul(c, src(c), imm, osz)));
    }
    case 0x80: case 0x81: case 0x82: case 0x83: {
      const sz = opc & 1 ? osz : 1;
      const m = modrm(d);
      const imm = opc === 0x83 ? d.immS8(sz) : d.imm(sz);
      const op = m.reg;
      if (op === 7) {
        const rd = rmRd(m, sz);
        return N((c) => { c.alu(7, rd(c), imm, sz); });
      }
      return N(rmw(m, sz, (c, v) => c.alu(op, v, imm, sz)));
    }
    case 0x84: case 0x85: {
      const sz = opc & 1 ? osz : 1;
      const m = modrm(d);
      const a = rmRd(m, sz), b = regRd(m.reg, sz);
      return N((c) => c.logic(a(c) & b(c), sz));
    }
    case 0x86: case 0x87: {
      const sz = opc & 1 ? osz : 1;
      const m = modrm(d);
      const rd = regRd(m.reg, sz), wr = regWr(m.reg, sz);
      return N(rmw(m, sz, (c, v) => { const t = rd(c); wr(c, v); return t; }));
    }
    case 0x88: case 0x89: {
      const sz = opc & 1 ? osz : 1;
      const m = modrm(d);
      const src = regRd(m.reg, sz), wr = rmWr(m, sz);
      return N((c) => wr(c, src(c)));
    }
    case 0x8a: case 0x8b: {
      const sz = opc & 1 ? osz : 1;
      const m = modrm(d);
      const src = rmRd(m, sz), wr = regWr(m.reg, sz);
      return N((c) => wr(c, src(c)));
    }
    case 0x8c: {
      const m = modrm(d);
      const s = m.reg, wr = m.ea ? rmWr(m, 2) : regWr(m.rm, osz);
      return N((c) => wr(c, c.seg[s]));
    }
    case 0x8d: {
      const m = modrm(d);
      if (!m.lea) return { exec: ud(d, "lea reg"), flow: true };
      const ea = m.lea, wr = regWr(m.reg, osz);
      return N((c) => wr(c, ea(c)));
    }
    case 0x8e: {
      const m = modrm(d);
      const s = m.reg, rd = rmRd(m, 2);
      return N((c) => { c.seg[s] = rd(c); });
    }
    case 0x8f: {
      const m = modrm(d);
      const wr = rmWr(m, osz);
      if (osz === 2) return N((c) => { const v = c.pop16(); wr(c, v); });
      return N((c) => { const v = c.pop32(); wr(c, v); });
    }
    case 0x90: return N(() => {});
    case 0x98:
      if (osz === 2) return N((c) => c.set16(EAX, sx8(c.r[EAX])));
      return N((c) => { c.r[EAX] = sx16(c.r[EAX]); });
    case 0x99:
      if (osz === 2) return N((c) => c.set16(EDX, sx16(c.r[EAX]) >> 15));
      return N((c) => { c.r[EDX] = c.r[EAX] >> 31; });
    case 0x9b: return N(() => {});
    case 0x9c:
      if (osz === 2) return N((c) => c.push16(c.getFlags()));
      return N((c) => c.push32(c.getFlags() & 0x00fcffff));
    case 0x9d:
      if (osz === 2) return N((c) => c.setFlags((c.getFlags() & 0xffff0000) | c.pop16() | 0x200));
      return N((c) => c.setFlags(c.pop32() | 0x200));
    case 0x9e:
      return N((c) => {
        c.materialize();
        c.flags = (c.flags & ~0xd5) | ((c.r[EAX] >> 8) & 0xd5);
      });
    case 0x9f: return N((c) => c.set8(4, (c.getFlags() & 0xd5) | 2));
    case 0xa0: case 0xa1: case 0xa2: case 0xa3: {
      const sz = opc & 1 ? osz : 1;
      const off = d.adsz === 2 ? d.u16() : d.u32();
      const ea = makeEA(-1, -1, 0, off | 0, d.seg);
      const ld = LD[sz], st = ST[sz], rr = regRd(EAX, sz), rw = regWr(EAX, sz);
      if (opc < 0xa2) return N((c) => rw(c, ld(c, ea(c))));
      return N((c) => st(c, ea(c), rr(c)));
    }
    case 0xa4: case 0xa5: case 0xa6: case 0xa7: case 0xaa: case 0xab:
    case 0xac: case 0xad: case 0xae: case 0xaf:
      return N(stringOp(d, opc));
    case 0xa8: case 0xa9: {
      const sz = opc & 1 ? osz : 1;
      const imm = d.imm(sz), rd = regRd(EAX, sz);
      return N((c) => c.logic(rd(c) & imm, sz));
    }
    case 0xc0: case 0xc1: case 0xd0: case 0xd1: case 0xd2: case 0xd3: {
      const sz = opc & 1 ? osz : 1;
      const m = modrm(d);
      const op = m.reg;
      if (opc <= 0xc1) {
        const n = d.u8();
        return N(rmw(m, sz, (c, v) => c.shift(op, v, n, sz)));
      }
      if (opc <= 0xd1) return N(rmw(m, sz, (c, v) => c.shift(op, v, 1, sz)));
      return N(rmw(m, sz, (c, v) => c.shift(op, v, c.r[ECX] & 0xff, sz)));
    }
    case 0xc2: {
      const n = d.u16();
      return F((c) => { c.eip = c.pop32(); c.r[ESP] += n; });
    }
    case 0xc3: return F((c) => { c.eip = c.pop32(); });
    case 0xc6: case 0xc7: {
      const sz = opc & 1 ? osz : 1;
      const m = modrm(d);
      const wr = rmWr(m, sz);
      const v = d.imm(sz);
      return N((c) => wr(c, v));
    }
    case 0xc8: {
      const size = d.u16(), level = d.u8() & 31;
      return N((c) => {
        c.push32(c.r[EBP]);
        const frame = c.r[ESP];
        for (let i = 1; i < level; i++) {
          c.r[EBP] -= 4;
          c.push32(c.dv.getUint32(c.r[EBP] >>> 0, true));
        }
        if (level > 0) c.push32(frame);
        c.r[EBP] = frame;
        c.r[ESP] -= size;
      });
    }
    case 0xc9: return N((c) => { c.r[ESP] = c.r[EBP]; c.r[EBP] = c.pop32(); });
    case 0xcc: {
      const at = d.start;
      return F(() => { throw new GuestFault("BP", at); });
    }
    case 0xcd: {
      const n = d.u8(), at = d.start;
      return F(() => { throw new GuestFault("INT", at, `int ${n.toString(16)}`); });
    }
    case 0xd4: {
      const base = d.u8();
      return N((c) => {
        if (base === 0) throw new GuestFault("DE", c.eip);
        const al = c.r[EAX] & 0xff;
        c.set16(EAX, (Math.floor(al / base) << 8) | (al % base));
        c.logic(al % base, 1);
      });
    }
    case 0xd5: {
      const base = d.u8();
      return N((c) => {
        const r = ((c.r[EAX] & 0xff) + ((c.r[EAX] >> 8) & 0xff) * base) & 0xff;
        c.set16(EAX, r);
        c.logic(r, 1);
      });
    }
    case 0xd6: return N((c) => c.set8(0, c.cf() ? 0xff : 0));
    case 0xd7: {
      const sb = d.seg === FS || d.seg === GS ? d.seg : -1;
      return N((c) => {
        const a = (c.r[EBX] + (c.r[EAX] & 0xff) + (sb >= 0 ? c.segBase[sb] : 0)) >>> 0;
        c.set8(0, c.dv.getUint8(a));
      });
    }
    case 0xe0: case 0xe1: case 0xe2: case 0xe3: {
      const rel = d.s8();
      const target = (d.p + rel) >>> 0;
      if (opc === 0xe3) return F((c) => { if (c.r[ECX] === 0) c.eip = target; });
      if (opc === 0xe2) return F((c) => { if (--c.r[ECX] !== 0) c.eip = target; });
      if (opc === 0xe1) return F((c) => { if (--c.r[ECX] !== 0 && c.zf()) c.eip = target; });
      return F((c) => { if (--c.r[ECX] !== 0 && !c.zf()) c.eip = target; });
    }
    case 0xe8: {
      const rel = osz === 2 ? d.s16() : d.s32();
      const next = d.p, target = (d.p + rel) >>> 0;
      return F((c) => { c.push32(next); c.eip = target; });
    }
    case 0xe9: {
      const rel = osz === 2 ? d.s16() : d.s32();
      const target = (d.p + rel) >>> 0;
      return F((c) => { c.eip = target; });
    }
    case 0xeb: {
      const rel = d.s8();
      const target = (d.p + rel) >>> 0;
      return F((c) => { c.eip = target; });
    }
    case 0xf4: {
      const at = d.start;
      return F(() => { throw new GuestFault("GP", at, "hlt"); });
    }
    case 0xf5: return N((c) => c.setCF(!c.cf()));
    case 0xf6: case 0xf7: {
      const sz = opc & 1 ? osz : 1;
      const m = modrm(d);
      const op = m.reg;
      if (op < 2) {
        const imm = d.imm(sz), rd = rmRd(m, sz);
        return N((c) => c.logic(rd(c) & imm, sz));
      }
      if (op === 2 || op === 3) return N(rmw(m, sz, (c, v) => (op === 2 ? ~v : c.neg(v, sz))));
      const rd = rmRd(m, sz);
      return N((c) => grp3(c, op, rd(c), sz, () => {}));
    }
    case 0xf8: return N((c) => c.setCF(false));
    case 0xf9: return N((c) => c.setCF(true));
    case 0xfa: case 0xfb: return N(() => {});
    case 0xfc: return N((c) => { c.flags &= ~DF; });
    case 0xfd: return N((c) => { c.flags |= DF; });
    case 0xfe: {
      const m = modrm(d);
      if (m.reg === 0) return N(rmw(m, 1, (c, v) => c.inc(v, 1)));
      if (m.reg === 1) return N(rmw(m, 1, (c, v) => c.dec(v, 1)));
      return { exec: ud(d, "fe group"), flow: true };
    }
    case 0xff: {
      const m = modrm(d);
      switch (m.reg) {
        case 0: return N(rmw(m, osz, (c, v) => c.inc(v, osz)));
        case 1: return N(rmw(m, osz, (c, v) => c.dec(v, osz)));
        case 2: {
          const rd = rmRd(m, 4), next = d.p;
          return F((c) => { const t = rd(c); c.push32(next); c.eip = t; });
        }
        case 4: {
          const rd = rmRd(m, 4);
          return F((c) => { c.eip = rd(c); });
        }
        case 6: {
          const rd = rmRd(m, osz);
          return N(osz === 2 ? (c) => c.push16(rd(c)) : (c) => c.push32(rd(c)));
        }
      }
      return { exec: ud(d, `ff /${m.reg}`), flow: true };
    }
  }
  return { exec: ud(d, `opcode ${opc.toString(16)}`), flow: true };
}

function decode0F(c: CPU, d: Dec): { exec: Exec; flow: boolean } {
  const opc = d.u8();
  const osz = d.opsz;
  const N = (exec: Exec) => ({ exec, flow: false });
  const F = (exec: Exec) => ({ exec, flow: true });

  if (opc >= 0x80 && opc <= 0x8f) {
    const rel = osz === 2 ? d.s16() : d.s32();
    const target = (d.p + rel) >>> 0, cc = opc & 15;
    return F((c) => { if (c.cond(cc)) c.eip = target; });
  }
  if (opc >= 0x90 && opc <= 0x9f) {
    const m = modrm(d);
    const wr = rmWr(m, 1), cc = opc & 15;
    return N((c) => wr(c, c.cond(cc) ? 1 : 0));
  }
  if (opc >= 0x40 && opc <= 0x4f) {
    const m = modrm(d);
    const rd = rmRd(m, osz), wr = regWr(m.reg, osz), cc = opc & 15;
    return N((c) => { const v = rd(c); if (c.cond(cc)) wr(c, v); });
  }
  if (opc >= 0xc8 && opc <= 0xcf) {
    const r = opc & 7;
    return N((c) => {
      const v = c.r[r];
      c.r[r] = ((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | (v >>> 24);
    });
  }
  if ((opc >= 0x60 && opc <= 0x6b) || opc === 0x6e || opc === 0x6f || (opc >= 0x71 && opc <= 0x76) ||
      opc === 0x7e || opc === 0x7f || (opc >= 0xd1 && opc <= 0xfe)) {
    return N(mmxOp(d, opc));
  }

  switch (opc) {
    case 0x0b: return { exec: ud(d, "ud2"), flow: true };
    case 0x1f: { modrm(d); return N(() => {}); }
    case 0x31: return N((c) => { const [lo, hi] = c.rdtsc(); c.r[EAX] = lo; c.r[EDX] = hi; });
    case 0x77: return N((c) => c.mmx.emms());
    case 0xa0: return N((c) => c.push32(c.seg[FS]));
    case 0xa1: return N((c) => { c.seg[FS] = c.pop32(); });
    case 0xa8: return N((c) => c.push32(c.seg[GS]));
    case 0xa9: return N((c) => { c.seg[GS] = c.pop32(); });
    case 0xa2: return N(cpuid);
    case 0xa3: case 0xab: case 0xb3: case 0xbb: {
      const m = modrm(d);
      const op = opc === 0xa3 ? 0 : opc === 0xab ? 1 : opc === 0xb3 ? 2 : 3;
      return N(bitOp(m, osz, op, regRd(m.reg, osz), false));
    }
    case 0xba: {
      const m = modrm(d);
      const imm = d.u8();
      if (m.reg < 4) return { exec: ud(d, "0f ba"), flow: true };
      return N(bitOp(m, osz, m.reg - 4, () => imm, true));
    }
    case 0xa4: case 0xa5: case 0xac: case 0xad: {
      const m = modrm(d);
      const src = regRd(m.reg, osz);
      const left = opc < 0xa8;
      if (opc & 1) return N(rmw(m, osz, (c, v) => shiftD(c, v, src(c), c.r[ECX], osz, left)));
      const n = d.u8();
      return N(rmw(m, osz, (c, v) => shiftD(c, v, src(c), n, osz, left)));
    }
    case 0xaf: {
      const m = modrm(d);
      const src = rmRd(m, osz), rd = regRd(m.reg, osz), wr = regWr(m.reg, osz);
      return N((c) => wr(c, imul(c, rd(c), src(c), osz)));
    }
    case 0xb0: case 0xb1: {
      const sz = opc & 1 ? osz : 1;
      const m = modrm(d);
      const src = regRd(m.reg, sz), acc = regRd(EAX, sz), accW = regWr(EAX, sz);
      return N(rmw(m, sz, (c, v) => {
        c.alu(7, acc(c), v, sz);
        if (c.zf()) return src(c);
        accW(c, v);
        return v;
      }));
    }
    case 0xb6: case 0xb7: case 0xbe: case 0xbf: {
      const m = modrm(d);
      const from = opc & 1 ? 2 : 1;
      const rd = rmRd(m, from), wr = regWr(m.reg, osz);
      if (opc < 0xb8) return N((c) => wr(c, rd(c)));
      if (from === 1) return N((c) => wr(c, sx8(rd(c))));
      return N((c) => wr(c, sx16(rd(c))));
    }
    case 0xbc: case 0xbd: {
      const m = modrm(d);
      const rd = rmRd(m, osz), wr = regWr(m.reg, osz);
      const fwd = opc === 0xbc;
      return N((c) => {
        const v = rd(c);
        c.materialize();
        if (v === 0) { c.flags |= ZF; return; }
        c.flags &= ~ZF;
        wr(c, fwd ? 31 - Math.clz32(v & -v) : 31 - Math.clz32(v));
      });
    }
    case 0xc0: case 0xc1: {
      const sz = opc & 1 ? osz : 1;
      const m = modrm(d);
      const rd = regRd(m.reg, sz), wr = regWr(m.reg, sz);
      return N(rmw(m, sz, (c, v) => {
        const s = rd(c);
        const r = c.alu(0, v, s, sz);
        wr(c, v);
        return r;
      }));
    }
    case 0xc7: {
      const m = modrm(d);
      if (m.reg !== 1 || !m.ea) return { exec: ud(d, "0f c7"), flow: true };
      const ea = m.ea;
      return N((c) => {
        const a = ea(c);
        const lo = c.dv.getUint32(a, true), hi = c.dv.getUint32(a + 4, true);
        c.materialize();
        if (lo === c.r[EAX] >>> 0 && hi === c.r[EDX] >>> 0) {
          c.flags |= ZF;
          c.dv.setUint32(a, c.r[EBX], true);
          c.dv.setUint32(a + 4, c.r[ECX], true);
        } else {
          c.flags &= ~ZF;
          c.r[EAX] = lo;
          c.r[EDX] = hi;
        }
      });
    }
  }
  return { exec: ud(d, `opcode 0f ${opc.toString(16)}`), flow: true };
}

function cpuid(c: CPU): void {
  const leaf = c.r[EAX] >>> 0;
  if (leaf === 0) {
    c.r[EAX] = 1;
    c.r[EBX] = 0x756e6547;
    c.r[EDX] = 0x49656e69;
    c.r[ECX] = 0x6c65746e;
  } else if (leaf === 1) {
    c.r[EAX] = 0x543;
    c.r[EBX] = 0;
    c.r[ECX] = 0;
    c.r[EDX] = 0x008001bf;
  } else {
    c.r[EAX] = 0;
    c.r[EBX] = 0;
    c.r[ECX] = 0;
    c.r[EDX] = 0;
  }
}

function daa(c: CPU): void {
  let al = c.r[EAX] & 0xff;
  const oldAl = al, oldCf = c.cf();
  let cf = 0, af = false;
  if ((al & 0xf) > 9 || c.af()) { al += 6; af = true; cf = oldCf || (al > 0xff ? 1 : 0); }
  if (oldAl > 0x99 || oldCf) { al += 0x60; cf = 1; }
  al &= 0xff;
  c.set8(0, al);
  bcdFlags(c, al, cf, af);
}
function das(c: CPU): void {
  let al = c.r[EAX] & 0xff;
  const oldAl = al, oldCf = c.cf();
  let cf = 0, af = false;
  if ((al & 0xf) > 9 || c.af()) { al -= 6; af = true; cf = oldCf || (al < 0 ? 1 : 0); }
  if (oldAl > 0x99 || oldCf) { al -= 0x60; cf = 1; }
  al &= 0xff;
  c.set8(0, al);
  bcdFlags(c, al, cf, af);
}
function aaa(c: CPU): void {
  if ((c.r[EAX] & 0xf) > 9 || c.af()) {
    c.set16(EAX, (c.r[EAX] + 0x106) & 0xffff);
    c.set8(0, c.r[EAX] & 0xf);
    bcdFlags(c, c.r[EAX] & 0xff, 1, true);
  } else {
    c.set8(0, c.r[EAX] & 0xf);
    bcdFlags(c, c.r[EAX] & 0xff, 0, false);
  }
}
function aas(c: CPU): void {
  if ((c.r[EAX] & 0xf) > 9 || c.af()) {
    c.set16(EAX, (c.r[EAX] - 6) & 0xffff);
    c.set8(4, ((c.r[EAX] >> 8) - 1) & 0xff);
    c.set8(0, c.r[EAX] & 0xf);
    bcdFlags(c, c.r[EAX] & 0xff, 1, true);
  } else {
    c.set8(0, c.r[EAX] & 0xf);
    bcdFlags(c, c.r[EAX] & 0xff, 0, false);
  }
}
function bcdFlags(c: CPU, al: number, cf: number, af: boolean): void {
  c.logic(al, 1);
  c.materialize();
  c.flags = (c.flags & ~(CF | 0x10)) | (cf ? CF : 0) | (af ? 0x10 : 0);
}

export function decodeBlock(c: CPU, addr: number, max = 64): Block {
  const insns: Insn[] = [];
  let p = addr;
  for (let n = 0; n < max; n++) {
    const d = new Dec(c.dv, p);
    let res: { exec: Exec; flow: boolean };
    try {
      res = decodeOne(c, d);
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      const at = p;
      res = { exec: () => { throw new GuestFault("PF", at, "code fetch"); }, flow: true };
      d.p = p + 1;
    }
    insns.push({ addr: p, len: d.p - p, next: d.p >>> 0, exec: res.exec, flow: res.flow });
    p = d.p >>> 0;
    if (res.flow) break;
  }
  void LF_NONE;
  return { start: addr, end: p, insns };
}
