import type { CPU } from "./cpu";
import { GuestFault } from "./cpu";
import { ST_MMX } from "./state";

/** 8 MMX registers plus a scratch slot (index 8) used for memory source operands. */
export class MMX {
  readonly b: Uint8Array;
  readonly sb: Int8Array;
  readonly w: Uint16Array;
  readonly sw: Int16Array;
  readonly d: Uint32Array;
  readonly sd: Int32Array;
  private readonly cpu: CPU;
  private readonly tmp = new Uint8Array(8);
  private readonly tw = new Uint16Array(this.tmp.buffer);

  constructor(cpu: CPU) {
    this.cpu = cpu;
    const { buf, stateBase } = cpu.mem;
    const o = stateBase + ST_MMX;
    this.b = new Uint8Array(buf, o, 72);
    this.sb = new Int8Array(buf, o, 72);
    this.w = new Uint16Array(buf, o, 36);
    this.sw = new Int16Array(buf, o, 36);
    this.d = new Uint32Array(buf, o, 18);
    this.sd = new Int32Array(buf, o, 18);
  }

  enter(): void {
    const f = this.cpu.fpu;
    f.top = 0;
    f.empty.fill(0);
  }
  emms(): void {
    this.cpu.fpu.empty.fill(1);
  }

  load64(slot: number, a: number): void {
    const dv = this.cpu.dv;
    this.d[slot * 2] = dv.getUint32(a, true);
    this.d[slot * 2 + 1] = dv.getUint32(a + 4, true);
  }
  store64(slot: number, a: number): void {
    const dv = this.cpu.dv;
    dv.setUint32(a, this.d[slot * 2], true);
    dv.setUint32(a + 4, this.d[slot * 2 + 1], true);
  }
  copy(dst: number, src: number): void {
    this.d[dst * 2] = this.d[src * 2];
    this.d[dst * 2 + 1] = this.d[src * 2 + 1];
  }

  /** Two-operand op for opcode 0F xx. */
  op(opc: number, dst: number, src: number): void {
    this.enter();
    const { b, sb, w, sw, d, sd } = this;
    const D8 = dst * 8, S8 = src * 8, D4 = dst * 4, S4 = src * 4, D2 = dst * 2, S2 = src * 2;
    const tmp = this.tmp, tw = this.tw;
    switch (opc) {
      case 0x60: for (let i = 0; i < 4; i++) { tmp[i * 2] = b[D8 + i]; tmp[i * 2 + 1] = b[S8 + i]; } b.set(tmp, D8); break;
      case 0x61: for (let i = 0; i < 2; i++) { tw[i * 2] = w[D4 + i]; tw[i * 2 + 1] = w[S4 + i]; } b.set(tmp, D8); break;
      case 0x62: d[D2 + 1] = d[S2]; break;
      case 0x68: for (let i = 0; i < 4; i++) { tmp[i * 2] = b[D8 + 4 + i]; tmp[i * 2 + 1] = b[S8 + 4 + i]; } b.set(tmp, D8); break;
      case 0x69: for (let i = 0; i < 2; i++) { tw[i * 2] = w[D4 + 2 + i]; tw[i * 2 + 1] = w[S4 + 2 + i]; } b.set(tmp, D8); break;
      case 0x6a: d[D2] = d[D2 + 1]; d[D2 + 1] = d[S2 + 1]; break;
      case 0x63: {
        for (let i = 0; i < 4; i++) tmp[i] = satS8(sw[D4 + i]);
        for (let i = 0; i < 4; i++) tmp[4 + i] = satS8(sw[S4 + i]);
        b.set(tmp, D8);
        break;
      }
      case 0x67: {
        for (let i = 0; i < 4; i++) tmp[i] = satU8(sw[D4 + i]);
        for (let i = 0; i < 4; i++) tmp[4 + i] = satU8(sw[S4 + i]);
        b.set(tmp, D8);
        break;
      }
      case 0x6b: {
        for (let i = 0; i < 2; i++) tw[i] = satS16(sd[D2 + i]);
        for (let i = 0; i < 2; i++) tw[2 + i] = satS16(sd[S2 + i]);
        b.set(tmp, D8);
        break;
      }
      case 0x64: for (let i = 0; i < 8; i++) b[D8 + i] = sb[D8 + i] > sb[S8 + i] ? 0xff : 0; break;
      case 0x65: for (let i = 0; i < 4; i++) w[D4 + i] = sw[D4 + i] > sw[S4 + i] ? 0xffff : 0; break;
      case 0x66: for (let i = 0; i < 2; i++) d[D2 + i] = sd[D2 + i] > sd[S2 + i] ? 0xffffffff : 0; break;
      case 0x74: for (let i = 0; i < 8; i++) b[D8 + i] = b[D8 + i] === b[S8 + i] ? 0xff : 0; break;
      case 0x75: for (let i = 0; i < 4; i++) w[D4 + i] = w[D4 + i] === w[S4 + i] ? 0xffff : 0; break;
      case 0x76: for (let i = 0; i < 2; i++) d[D2 + i] = d[D2 + i] === d[S2 + i] ? 0xffffffff : 0; break;
      case 0xd1: this.shiftW(dst, this.count(src), 0); break;
      case 0xd2: this.shiftD(dst, this.count(src), 0); break;
      case 0xd3: this.shiftQ(dst, this.count(src), 0); break;
      case 0xe1: this.shiftW(dst, this.count(src), 1); break;
      case 0xe2: this.shiftD(dst, this.count(src), 1); break;
      case 0xf1: this.shiftW(dst, this.count(src), 2); break;
      case 0xf2: this.shiftD(dst, this.count(src), 2); break;
      case 0xf3: this.shiftQ(dst, this.count(src), 2); break;
      case 0xd5: for (let i = 0; i < 4; i++) w[D4 + i] = Math.imul(sw[D4 + i], sw[S4 + i]); break;
      case 0xe5: for (let i = 0; i < 4; i++) w[D4 + i] = Math.imul(sw[D4 + i], sw[S4 + i]) >> 16; break;
      case 0xf5: {
        const r0 = Math.imul(sw[D4], sw[S4]) + Math.imul(sw[D4 + 1], sw[S4 + 1]);
        const r1 = Math.imul(sw[D4 + 2], sw[S4 + 2]) + Math.imul(sw[D4 + 3], sw[S4 + 3]);
        d[D2] = r0;
        d[D2 + 1] = r1;
        break;
      }
      case 0xd8: for (let i = 0; i < 8; i++) b[D8 + i] = Math.max(0, b[D8 + i] - b[S8 + i]); break;
      case 0xd9: for (let i = 0; i < 4; i++) w[D4 + i] = Math.max(0, w[D4 + i] - w[S4 + i]); break;
      case 0xdc: for (let i = 0; i < 8; i++) b[D8 + i] = Math.min(255, b[D8 + i] + b[S8 + i]); break;
      case 0xdd: for (let i = 0; i < 4; i++) w[D4 + i] = Math.min(65535, w[D4 + i] + w[S4 + i]); break;
      case 0xe8: for (let i = 0; i < 8; i++) b[D8 + i] = satS8(sb[D8 + i] - sb[S8 + i]); break;
      case 0xe9: for (let i = 0; i < 4; i++) w[D4 + i] = satS16(sw[D4 + i] - sw[S4 + i]); break;
      case 0xec: for (let i = 0; i < 8; i++) b[D8 + i] = satS8(sb[D8 + i] + sb[S8 + i]); break;
      case 0xed: for (let i = 0; i < 4; i++) w[D4 + i] = satS16(sw[D4 + i] + sw[S4 + i]); break;
      case 0xdb: d[D2] &= d[S2]; d[D2 + 1] &= d[S2 + 1]; break;
      case 0xdf: d[D2] = ~d[D2] & d[S2]; d[D2 + 1] = ~d[D2 + 1] & d[S2 + 1]; break;
      case 0xeb: d[D2] |= d[S2]; d[D2 + 1] |= d[S2 + 1]; break;
      case 0xef: d[D2] ^= d[S2]; d[D2 + 1] ^= d[S2 + 1]; break;
      case 0xf8: for (let i = 0; i < 8; i++) b[D8 + i] = b[D8 + i] - b[S8 + i]; break;
      case 0xf9: for (let i = 0; i < 4; i++) w[D4 + i] = w[D4 + i] - w[S4 + i]; break;
      case 0xfa: for (let i = 0; i < 2; i++) d[D2 + i] = d[D2 + i] - d[S2 + i]; break;
      case 0xfc: for (let i = 0; i < 8; i++) b[D8 + i] = b[D8 + i] + b[S8 + i]; break;
      case 0xfd: for (let i = 0; i < 4; i++) w[D4 + i] = w[D4 + i] + w[S4 + i]; break;
      case 0xfe: for (let i = 0; i < 2; i++) d[D2 + i] = d[D2 + i] + d[S2 + i]; break;
      default: throw new GuestFault("UD", this.cpu.eip, `mmx 0F ${opc.toString(16)}`);
    }
  }

  private count(src: number): number {
    const hi = this.d[src * 2 + 1];
    return hi !== 0 ? 64 : Math.min(this.d[src * 2], 64);
  }

  /** kind: 0 logical right, 1 arithmetic right, 2 left. */
  shiftW(r: number, n: number, kind: number): void {
    for (let i = 0; i < 4; i++) {
      const k = r * 4 + i;
      if (kind === 1) this.w[k] = this.sw[k] >> Math.min(n, 15);
      else if (n > 15) this.w[k] = 0;
      else this.w[k] = kind === 0 ? this.w[k] >>> n : this.w[k] << n;
    }
  }
  shiftD(r: number, n: number, kind: number): void {
    for (let i = 0; i < 2; i++) {
      const k = r * 2 + i;
      if (kind === 1) this.d[k] = this.sd[k] >> Math.min(n, 31);
      else if (n > 31) this.d[k] = 0;
      else this.d[k] = kind === 0 ? this.d[k] >>> n : this.d[k] << n;
    }
  }
  shiftQ(r: number, n: number, kind: number): void {
    const lo = this.d[r * 2], hi = this.d[r * 2 + 1];
    if (n > 63) {
      this.d[r * 2] = 0;
      this.d[r * 2 + 1] = 0;
      return;
    }
    const v = (BigInt(hi) << 32n) | BigInt(lo);
    const res = BigInt.asUintN(64, kind === 0 ? v >> BigInt(n) : v << BigInt(n));
    this.d[r * 2] = Number(res & 0xffffffffn);
    this.d[r * 2 + 1] = Number(res >> 32n);
  }
}

function satS8(v: number): number {
  return v > 127 ? 127 : v < -128 ? -128 : v;
}
function satU8(v: number): number {
  return v > 255 ? 255 : v < 0 ? 0 : v;
}
function satS16(v: number): number {
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}
