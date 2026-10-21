import type { CPU } from "./cpu";
import { GuestFault } from "./cpu";

const f64 = new Float64Array(1);
const f64u = new Uint32Array(f64.buffer);
const f32 = new Float32Array(1);

const C0 = 0x100, C1 = 0x200, C2 = 0x400, C3 = 0x4000;

export class FPU {
  readonly st = new Float64Array(8);
  /** 1 = empty. */
  readonly empty = new Uint8Array(8).fill(1);
  top = 0;
  cw = 0x037f;
  sw = 0;
  private readonly cpu: CPU;

  constructor(cpu: CPU) {
    this.cpu = cpu;
  }

  reset(): void {
    this.st.fill(0);
    this.empty.fill(1);
    this.top = 0;
    this.cw = 0x037f;
    this.sw = 0;
  }

  getSW(): number {
    return (this.sw & ~0x3800) | ((this.top & 7) << 11);
  }
  setSW(v: number): void {
    this.sw = v & ~0x3800;
    this.top = (v >> 11) & 7;
  }
  tagWord(): number {
    let t = 0;
    for (let i = 0; i < 8; i++) {
      let tag: number;
      if (this.empty[i]) tag = 3;
      else {
        const v = this.st[i];
        tag = v === 0 ? 1 : Number.isFinite(v) ? 0 : 2;
      }
      t |= tag << (i * 2);
    }
    return t;
  }
  setTagWord(t: number): void {
    for (let i = 0; i < 8; i++) this.empty[i] = ((t >> (i * 2)) & 3) === 3 ? 1 : 0;
  }

  get(i: number): number {
    return this.st[(this.top + i) & 7];
  }
  set(i: number, v: number): void {
    const p = (this.top + i) & 7;
    this.st[p] = v;
    this.empty[p] = 0;
  }
  push(v: number): void {
    this.top = (this.top - 1) & 7;
    if (!this.empty[this.top]) this.sw |= 0x41 | C1;
    this.st[this.top] = v;
    this.empty[this.top] = 0;
  }
  pop(): number {
    const v = this.st[this.top];
    this.empty[this.top] = 1;
    this.top = (this.top + 1) & 7;
    return v;
  }
  isEmpty(i: number): boolean {
    return this.empty[(this.top + i) & 7] === 1;
  }

  /** Rounds per the control word's rounding field. */
  round(v: number): number {
    switch ((this.cw >> 10) & 3) {
      case 0: {
        const r = Math.round(v);
        return r - v === 0.5 && r % 2 !== 0 ? r - 1 : r;
      }
      case 1: return Math.floor(v);
      case 2: return Math.ceil(v);
      default: return Math.trunc(v);
    }
  }

  toInt(v: number, bits: 16 | 32 | 64): number {
    const r = this.round(v);
    if (bits === 16) return r >= -32768 && r <= 32767 ? r & 0xffff : 0x8000;
    if (bits === 32) return r >= -2147483648 && r <= 2147483647 ? r | 0 : 0x80000000 | 0;
    return Number.isFinite(r) && r >= -9223372036854775808 && r < 9223372036854775808 ? r : NaN;
  }

  compare(a: number, b: number): void {
    this.sw &= ~(C0 | C2 | C3);
    if (Number.isNaN(a) || Number.isNaN(b)) this.sw |= C0 | C2 | C3;
    else if (a < b) this.sw |= C0;
    else if (a === b) this.sw |= C3;
  }
  /** fcomi-style compare into EFLAGS. */
  compareFlags(a: number, b: number): void {
    const c = this.cpu;
    c.materialize();
    let f = c.flags & ~(0x1 | 0x4 | 0x40 | 0x800 | 0x80 | 0x10);
    if (Number.isNaN(a) || Number.isNaN(b)) f |= 0x45;
    else if (a < b) f |= 0x1;
    else if (a === b) f |= 0x40;
    c.flags = f;
  }

  xam(): void {
    const v = this.get(0);
    this.sw &= ~(C0 | C1 | C2 | C3);
    f64[0] = v;
    if (f64u[1] >>> 31) this.sw |= C1;
    if (this.isEmpty(0)) this.sw |= C3 | C0;
    else if (Number.isNaN(v)) this.sw |= C0;
    else if (!Number.isFinite(v)) this.sw |= C2 | C0;
    else if (v === 0) this.sw |= C3;
    else if (Math.abs(v) < 2.2250738585072014e-308) this.sw |= C3 | C2;
    else this.sw |= C2;
  }

  // ---------- memory formats ----------

  readF32(a: number): number {
    return this.cpu.dv.getFloat32(a, true);
  }
  readF64(a: number): number {
    return this.cpu.dv.getFloat64(a, true);
  }
  writeF32(a: number, v: number): void {
    this.cpu.dv.setFloat32(a, v, true);
  }
  writeF64(a: number, v: number): void {
    this.cpu.dv.setFloat64(a, v, true);
  }
  readI64(a: number): number {
    const dv = this.cpu.dv;
    return dv.getInt32(a + 4, true) * 4294967296 + dv.getUint32(a, true);
  }
  writeI64(a: number, v: number): void {
    const dv = this.cpu.dv;
    if (Number.isNaN(v)) {
      dv.setUint32(a, 0, true);
      dv.setUint32(a + 4, 0x80000000, true);
      return;
    }
    const big = BigInt.asUintN(64, BigInt(v));
    dv.setUint32(a, Number(big & 0xffffffffn), true);
    dv.setUint32(a + 4, Number(big >> 32n), true);
  }
  readF80(a: number): number {
    const dv = this.cpu.dv;
    const lo = dv.getUint32(a, true);
    const hi = dv.getUint32(a + 4, true);
    const se = dv.getUint16(a + 8, true);
    const sign = se & 0x8000 ? -1 : 1;
    const exp = se & 0x7fff;
    if (exp === 0x7fff) {
      if ((hi & 0x7fffffff) === 0 && lo === 0) return sign * Infinity;
      return NaN;
    }
    if (exp === 0 && hi === 0 && lo === 0) return sign * 0;
    const mant = hi * 4294967296 + lo;
    return sign * mant * Math.pow(2, exp - 16383 - 63);
  }
  writeF80(a: number, v: number): void {
    const dv = this.cpu.dv;
    f64[0] = v;
    const sign = f64u[1] >>> 31;
    let exp = (f64u[1] >>> 20) & 0x7ff;
    let mhi = f64u[1] & 0xfffff;
    let mlo = f64u[0];
    let e80: number, hi: number, lo: number;
    if (exp === 0x7ff) {
      e80 = 0x7fff;
      hi = 0x80000000 | (mhi << 11) | (mlo >>> 21);
      lo = mlo << 11;
      if (mhi === 0 && mlo === 0) hi = 0x80000000;
      else hi |= 0x40000000;
    } else if (exp === 0 && mhi === 0 && mlo === 0) {
      e80 = 0;
      hi = 0;
      lo = 0;
    } else {
      if (exp === 0) {
        exp = 1;
        while ((mhi & 0x100000) === 0) {
          mhi = (mhi << 1) | (mlo >>> 31);
          mlo <<= 1;
          exp--;
        }
        mhi &= 0xfffff;
      }
      e80 = exp - 1023 + 16383;
      hi = 0x80000000 | (mhi << 11) | (mlo >>> 21);
      lo = mlo << 11;
    }
    dv.setUint32(a, lo >>> 0, true);
    dv.setUint32(a + 4, hi >>> 0, true);
    dv.setUint16(a + 8, e80 | (sign << 15), true);
  }
  roundF32(v: number): number {
    f32[0] = v;
    return f32[0];
  }

  readBCD(a: number): number {
    const dv = this.cpu.dv;
    let v = 0;
    for (let i = 8; i >= 0; i--) {
      const b = dv.getUint8(a + i);
      v = v * 100 + (b >> 4) * 10 + (b & 15);
    }
    return dv.getUint8(a + 9) & 0x80 ? -v : v;
  }
  writeBCD(a: number, v: number): void {
    const dv = this.cpu.dv;
    let n = Math.abs(this.round(v));
    for (let i = 0; i < 9; i++) {
      const d0 = n % 10;
      n = Math.floor(n / 10);
      const d1 = n % 10;
      n = Math.floor(n / 10);
      dv.setUint8(a + i, (d1 << 4) | d0);
    }
    dv.setUint8(a + 9, v < 0 ? 0x80 : 0);
  }

  // ---------- environment ----------

  /** 28-byte protected-mode environment. */
  storeEnv(a: number): void {
    const dv = this.cpu.dv;
    dv.setUint32(a, this.cw | 0xffff0000, true);
    dv.setUint32(a + 4, this.getSW() | 0xffff0000, true);
    dv.setUint32(a + 8, this.tagWord() | 0xffff0000, true);
    for (let i = 12; i < 28; i += 4) dv.setUint32(a + i, 0, true);
  }
  loadEnv(a: number): void {
    const dv = this.cpu.dv;
    this.cw = dv.getUint16(a, true);
    this.setSW(dv.getUint16(a + 4, true));
    this.setTagWord(dv.getUint16(a + 8, true));
  }
  save(a: number): void {
    this.storeEnv(a);
    for (let i = 0; i < 8; i++) this.writeF80(a + 28 + i * 10, this.get(i));
    this.reset();
  }
  restore(a: number): void {
    this.loadEnv(a);
    const tags = this.empty.slice();
    for (let i = 0; i < 8; i++) this.st[(this.top + i) & 7] = this.readF80(a + 28 + i * 10);
    this.empty.set(tags);
  }

  // ---------- arithmetic dispatch ----------

  /** op: 0 add, 1 mul, 2 com, 3 comp, 4 sub, 5 subr, 6 div, 7 divr. Result into ST(0). */
  arith(op: number, b: number): void {
    const a = this.get(0);
    switch (op) {
      case 0: this.set(0, a + b); break;
      case 1: this.set(0, a * b); break;
      case 2: this.compare(a, b); break;
      case 3: this.compare(a, b); this.pop(); break;
      case 4: this.set(0, a - b); break;
      case 5: this.set(0, b - a); break;
      case 6: this.div(0, a, b); break;
      default: this.div(0, b, a); break;
    }
  }
  /** Register form `op ST(i), ST(0)` (DC / DE groups). */
  arithTo(op: number, i: number, pop: boolean): void {
    const a = this.get(i), b = this.get(0);
    switch (op) {
      case 0: this.set(i, a + b); break;
      case 1: this.set(i, a * b); break;
      case 2: this.compare(b, a); break;
      case 3: this.compare(b, a); this.pop(); break;
      case 4: this.set(i, b - a); break;
      case 5: this.set(i, a - b); break;
      case 6: this.div(i, b, a); break;
      default: this.div(i, a, b); break;
    }
    if (pop) this.pop();
  }
  private div(dst: number, a: number, b: number): void {
    if (b === 0 && !Number.isNaN(a)) this.sw |= a === 0 ? 0x1 : 0x4;
    this.set(dst, a / b);
  }

  /** D9 E0..FF register-less ops. */
  special(op: number): void {
    const v = this.get(0);
    switch (op) {
      case 0xe0: this.set(0, -v); break;
      case 0xe1: this.set(0, Math.abs(v)); break;
      case 0xe4: this.compare(v, 0); break;
      case 0xe5: this.xam(); break;
      case 0xe8: this.push(1); break;
      case 0xe9: this.push(Math.log2(10)); break;
      case 0xea: this.push(Math.LOG2E); break;
      case 0xeb: this.push(Math.PI); break;
      case 0xec: this.push(Math.log10(2)); break;
      case 0xed: this.push(Math.LN2); break;
      case 0xee: this.push(0); break;
      case 0xf0: this.set(0, Math.pow(2, v) - 1); break;
      case 0xf1: { const y = this.get(1); this.pop(); this.set(0, y * Math.log2(v)); break; }
      case 0xf2: {
        this.sw &= ~C2;
        if (Math.abs(v) >= 2 ** 63) { this.sw |= C2; break; }
        this.set(0, Math.tan(v));
        this.push(1);
        break;
      }
      case 0xf3: { const y = this.get(1); this.pop(); this.set(0, Math.atan2(y, v)); break; }
      case 0xf4: {
        if (v === 0 || !Number.isFinite(v)) { this.set(0, v); this.push(v); break; }
        const e = Math.floor(Math.log2(Math.abs(v)));
        let m = v / Math.pow(2, e);
        let ee = e;
        if (Math.abs(m) >= 2) { m /= 2; ee++; }
        if (Math.abs(m) < 1) { m *= 2; ee--; }
        this.set(0, ee);
        this.push(m);
        break;
      }
      case 0xf5: this.prem(true); break;
      case 0xf6: this.top = (this.top - 1) & 7; break;
      case 0xf7: this.top = (this.top + 1) & 7; break;
      case 0xf8: this.prem(false); break;
      case 0xf9: { const y = this.get(1); this.pop(); this.set(0, y * Math.log2(v + 1)); break; }
      case 0xfa: this.set(0, Math.sqrt(v)); break;
      case 0xfb: {
        this.sw &= ~C2;
        if (Math.abs(v) >= 2 ** 63) { this.sw |= C2; break; }
        this.set(0, Math.sin(v));
        this.push(Math.cos(v));
        break;
      }
      case 0xfc: this.set(0, this.round(v)); break;
      case 0xfd: this.set(0, ldexp(v, Math.trunc(this.get(1)))); break;
      case 0xfe: this.sw &= ~C2; if (Math.abs(v) >= 2 ** 63) this.sw |= C2; else this.set(0, Math.sin(v)); break;
      case 0xff: this.sw &= ~C2; if (Math.abs(v) >= 2 ** 63) this.sw |= C2; else this.set(0, Math.cos(v)); break;
      case 0xd0: break;
      default: throw new GuestFault("UD", this.cpu.eip, `fpu D9 ${op.toString(16)}`);
    }
  }

  private prem(ieee: boolean): void {
    const a = this.get(0), b = this.get(1);
    const q = ieee ? Math.round(a / b) : Math.trunc(a / b);
    const r = a - q * b;
    this.set(0, r);
    const qi = Math.abs(q);
    this.sw &= ~(C0 | C1 | C2 | C3);
    if (qi & 1) this.sw |= C1;
    if (qi & 2) this.sw |= C3;
    if (qi & 4) this.sw |= C0;
  }
}

function ldexp(v: number, e: number): number {
  if (v === 0 || !Number.isFinite(v) || Number.isNaN(e)) return v;
  if (e > 4000) e = 4000;
  if (e < -4000) e = -4000;
  while (e > 1000) { v *= 2 ** 1000; e -= 1000; }
  while (e < -1000) { v *= 2 ** -1000; e += 1000; }
  return v * 2 ** e;
}
