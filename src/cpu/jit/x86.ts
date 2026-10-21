/** Structured x86 decoder for the JIT. Anything not modelled decodes as `interp` (run by the interpreter). */

export interface Mem {
  base: number;
  index: number;
  scale: number;
  disp: number;
  /** -1 flat, 4 FS, 5 GS. */
  seg: number;
}

export type Opnd =
  | { t: "r"; r: number; sz: number }
  | { t: "m"; m: Mem; sz: number }
  | { t: "i"; v: number; sz: number };

export interface JInsn {
  addr: number;
  next: number;
  op: string;
  sz: number;
  a?: Opnd;
  b?: Opnd;
  c?: Opnd;
  cc?: number;
  target?: number;
  rep?: number;
  /** Sub-operation: ALU/shift index, FPU/MMX opcode details. */
  x?: number;
  y?: number;
  /** Ends the block (control flow or interpreter-only instruction that may branch). */
  flow?: boolean;
}

export const ALU_OPS = ["add", "or", "adc", "sbb", "and", "sub", "xor", "cmp"];
export const SHIFT_OPS = ["rol", "ror", "rcl", "rcr", "shl", "shr", "shl", "sar"];

class Reader {
  pos: number;
  constructor(private u8: Uint8Array, start: number) {
    this.pos = start;
  }
  u8_(): number {
    return this.u8[this.pos++];
  }
  s8(): number {
    return (this.u8[this.pos++] << 24) >> 24;
  }
  u16(): number {
    const v = this.u8[this.pos] | (this.u8[this.pos + 1] << 8);
    this.pos += 2;
    return v;
  }
  s32(): number {
    const p = this.pos;
    this.pos += 4;
    return this.u8[p] | (this.u8[p + 1] << 8) | (this.u8[p + 2] << 16) | (this.u8[p + 3] << 24);
  }
  imm(sz: number): number {
    if (sz === 1) return this.u8_();
    if (sz === 2) return this.u16();
    return this.s32();
  }
}

interface ModRM {
  mod: number;
  reg: number;
  rm: number;
  mem: Mem | null;
}

function modrm(rd: Reader, seg: number): ModRM {
  const b = rd.u8_();
  const mod = b >> 6, reg = (b >> 3) & 7, rm = b & 7;
  if (mod === 3) return { mod, reg, rm, mem: null };
  let base = -1, index = -1, scale = 0, disp = 0;
  if (rm === 4) {
    const sib = rd.u8_();
    scale = sib >> 6;
    index = (sib >> 3) & 7;
    if (index === 4) index = -1;
    base = sib & 7;
    if (base === 5 && mod === 0) {
      base = -1;
      disp = rd.s32();
    }
  } else if (rm === 5 && mod === 0) {
    disp = rd.s32();
  } else base = rm;
  if (mod === 1) disp = rd.s8();
  else if (mod === 2) disp = rd.s32();
  return { mod, reg, rm, mem: { base, index, scale, disp, seg } };
}

const R = (r: number, sz: number): Opnd => ({ t: "r", r, sz });
const I = (v: number, sz: number): Opnd => ({ t: "i", v, sz });
const rmOp = (m: ModRM, sz: number): Opnd => (m.mem ? { t: "m", m: m.mem, sz } : R(m.rm, sz));

export function decode(u8: Uint8Array, addr: number): JInsn {
  const rd = new Reader(u8, addr);
  let opsize = 4, seg = -1, rep = 0, addr16 = false;
  let opc: number;
  for (;;) {
    opc = rd.u8_();
    if (opc === 0x66) opsize = 2;
    else if (opc === 0x67) addr16 = true;
    else if (opc === 0x64) seg = 4;
    else if (opc === 0x65) seg = 5;
    else if (opc === 0x26 || opc === 0x2e || opc === 0x36 || opc === 0x3e) seg = -1;
    else if (opc === 0xf2 || opc === 0xf3) rep = opc;
    else if (opc === 0xf0) continue;
    else break;
    if (rd.pos - addr > 14) break;
  }
  const done = (i: Omit<JInsn, "addr" | "next">): JInsn => ({ ...i, addr, next: rd.pos });
  const interp = (flow = false): JInsn => ({ op: "interp", sz: opsize, addr, next: 0, flow });
  if (addr16) return interp(true);
  const sz = opsize;

  if (opc < 0x40 && (opc & 7) < 6) {
    const x = opc >> 3, form = opc & 7;
    if (form === 0 || form === 1) {
      const s = form === 0 ? 1 : sz;
      const m = modrm(rd, seg);
      return done({ op: "alu", x, sz: s, a: rmOp(m, s), b: R(m.reg, s) });
    }
    if (form === 2 || form === 3) {
      const s = form === 2 ? 1 : sz;
      const m = modrm(rd, seg);
      return done({ op: "alu", x, sz: s, a: R(m.reg, s), b: rmOp(m, s) });
    }
    const s = form === 4 ? 1 : sz;
    return done({ op: "alu", x, sz: s, a: R(0, s), b: I(rd.imm(s), s) });
  }
  if (opc >= 0x40 && opc <= 0x4f) return done({ op: opc < 0x48 ? "inc" : "dec", sz, a: R(opc & 7, sz) });
  if (opc >= 0x50 && opc <= 0x57) return done({ op: "push", sz, a: R(opc & 7, sz) });
  if (opc >= 0x58 && opc <= 0x5f) return done({ op: "pop", sz, a: R(opc & 7, sz) });
  if (opc >= 0x70 && opc <= 0x7f) {
    const d = rd.s8();
    return done({ op: "jcc", sz, cc: opc & 15, target: (rd.pos + d) >>> 0, flow: true });
  }
  if (opc >= 0x91 && opc <= 0x97) return done({ op: "xchg", sz, a: R(0, sz), b: R(opc & 7, sz) });
  if (opc >= 0xb0 && opc <= 0xb7) return done({ op: "mov", sz: 1, a: R(opc & 7, 1), b: I(rd.u8_(), 1) });
  if (opc >= 0xb8 && opc <= 0xbf) return done({ op: "mov", sz, a: R(opc & 7, sz), b: I(rd.imm(sz), sz) });
  if (opc >= 0xd8 && opc <= 0xdf) return decodeFpu(rd, opc, seg, done, interp);

  switch (opc) {
    case 0x0f: return decode0f(rd, seg, sz, rep, done, interp);
    case 0x68: return done({ op: "push", sz, a: I(rd.imm(sz), sz) });
    case 0x6a: return done({ op: "push", sz, a: I(rd.s8(), sz) });
    case 0x69: case 0x6b: {
      const m = modrm(rd, seg);
      const imm = opc === 0x69 ? rd.imm(sz) : rd.s8();
      return done({ op: "imul3", sz, a: R(m.reg, sz), b: rmOp(m, sz), c: I(imm, sz) });
    }
    case 0x80: case 0x81: case 0x82: case 0x83: {
      const s = opc === 0x81 || opc === 0x83 ? sz : 1;
      const m = modrm(rd, seg);
      const imm = opc === 0x81 ? rd.imm(s) : opc === 0x83 ? rd.s8() : rd.u8_();
      return done({ op: "alu", x: m.reg, sz: s, a: rmOp(m, s), b: I(imm, s) });
    }
    case 0x84: case 0x85: {
      const s = opc === 0x84 ? 1 : sz;
      const m = modrm(rd, seg);
      return done({ op: "test", sz: s, a: rmOp(m, s), b: R(m.reg, s) });
    }
    case 0x86: case 0x87: {
      const s = opc === 0x86 ? 1 : sz;
      const m = modrm(rd, seg);
      return done({ op: "xchg", sz: s, a: rmOp(m, s), b: R(m.reg, s) });
    }
    case 0x88: case 0x89: {
      const s = opc === 0x88 ? 1 : sz;
      const m = modrm(rd, seg);
      return done({ op: "mov", sz: s, a: rmOp(m, s), b: R(m.reg, s) });
    }
    case 0x8a: case 0x8b: {
      const s = opc === 0x8a ? 1 : sz;
      const m = modrm(rd, seg);
      return done({ op: "mov", sz: s, a: R(m.reg, s), b: rmOp(m, s) });
    }
    case 0x8d: {
      const m = modrm(rd, -1);
      if (!m.mem) return interp(true);
      return done({ op: "lea", sz, a: R(m.reg, sz), b: { t: "m", m: m.mem, sz } });
    }
    case 0x8f: {
      const m = modrm(rd, seg);
      if (m.reg !== 0) return interp(true);
      return done({ op: "pop", sz, a: rmOp(m, sz) });
    }
    case 0x90: return done({ op: "nop", sz });
    case 0x98: return done({ op: sz === 4 ? "cwde" : "cbw", sz });
    case 0x99: return done({ op: sz === 4 ? "cdq" : "cwd", sz });
    case 0x9b: return done({ op: "nop", sz });
    case 0x9e: return done({ op: "sahf", sz: 1 });
    case 0x9f: return done({ op: "lahf", sz: 1 });
    case 0xa0: case 0xa1: case 0xa2: case 0xa3: {
      const s = opc & 1 ? sz : 1;
      const mem: Opnd = { t: "m", m: { base: -1, index: -1, scale: 0, disp: rd.s32(), seg }, sz: s };
      return opc < 0xa2 ? done({ op: "mov", sz: s, a: R(0, s), b: mem }) : done({ op: "mov", sz: s, a: mem, b: R(0, s) });
    }
    case 0xa4: case 0xa5: case 0xaa: case 0xab: case 0xac: case 0xad:
    case 0xa6: case 0xa7: case 0xae: case 0xaf: {
      const s = opc & 1 ? sz : 1;
      const kind = { 0xa4: "movs", 0xa6: "cmps", 0xaa: "stos", 0xac: "lods", 0xae: "scas" }[opc & ~1]!;
      return done({ op: kind, sz: s, rep, x: seg });
    }
    case 0xa8: return done({ op: "test", sz: 1, a: R(0, 1), b: I(rd.u8_(), 1) });
    case 0xa9: return done({ op: "test", sz, a: R(0, sz), b: I(rd.imm(sz), sz) });
    case 0xc0: case 0xc1: case 0xd0: case 0xd1: case 0xd2: case 0xd3: {
      const s = opc & 1 ? sz : 1;
      const m = modrm(rd, seg);
      const count: Opnd = opc <= 0xc1 ? I(rd.u8_(), 1) : opc <= 0xd1 ? I(1, 1) : R(1, 1);
      return done({ op: "shift", x: m.reg, sz: s, a: rmOp(m, s), b: count });
    }
    case 0xc2: return done({ op: "ret", sz, x: rd.u16(), flow: true });
    case 0xc3: return done({ op: "ret", sz, x: 0, flow: true });
    case 0xc6: case 0xc7: {
      const s = opc === 0xc6 ? 1 : sz;
      const m = modrm(rd, seg);
      if (m.reg !== 0) return interp(true);
      return done({ op: "mov", sz: s, a: rmOp(m, s), b: I(rd.imm(s), s) });
    }
    case 0xc9: return done({ op: "leave", sz });
    case 0xe0: case 0xe1: case 0xe2: case 0xe3: {
      const d = rd.s8();
      const op = ["loopne", "loope", "loop", "jecxz"][opc - 0xe0];
      return done({ op, sz, target: (rd.pos + d) >>> 0, flow: true });
    }
    case 0xe8: {
      const d = rd.s32();
      return done({ op: "call", sz, target: (rd.pos + d) >>> 0, flow: true });
    }
    case 0xe9: {
      const d = rd.s32();
      return done({ op: "jmp", sz, target: (rd.pos + d) >>> 0, flow: true });
    }
    case 0xeb: {
      const d = rd.s8();
      return done({ op: "jmp", sz, target: (rd.pos + d) >>> 0, flow: true });
    }
    case 0xf5: return done({ op: "cmc", sz });
    case 0xf6: case 0xf7: {
      const s = opc === 0xf6 ? 1 : sz;
      const m = modrm(rd, seg);
      const a = rmOp(m, s);
      switch (m.reg) {
        case 0: case 1: return done({ op: "test", sz: s, a, b: I(rd.imm(s), s) });
        case 2: return done({ op: "not", sz: s, a });
        case 3: return done({ op: "neg", sz: s, a });
        case 4: return done({ op: "mul", sz: s, a });
        case 5: return done({ op: "imul1", sz: s, a });
        case 6: return done({ op: "div", sz: s, a });
        default: return done({ op: "idiv", sz: s, a });
      }
    }
    case 0xf8: return done({ op: "clc", sz });
    case 0xf9: return done({ op: "stc", sz });
    case 0xfc: return done({ op: "cld", sz });
    case 0xfd: return done({ op: "std", sz });
    case 0xfe: {
      const m = modrm(rd, seg);
      if (m.reg > 1) return interp(true);
      return done({ op: m.reg === 0 ? "inc" : "dec", sz: 1, a: rmOp(m, 1) });
    }
    case 0xff: {
      const m = modrm(rd, seg);
      const a = rmOp(m, sz);
      switch (m.reg) {
        case 0: return done({ op: "inc", sz, a });
        case 1: return done({ op: "dec", sz, a });
        case 2: return done({ op: "calli", sz: 4, a: rmOp(m, 4), flow: true });
        case 4: return done({ op: "jmpi", sz: 4, a: rmOp(m, 4), flow: true });
        case 6: return done({ op: "push", sz, a });
        default: return interp(true);
      }
    }
  }
  return interp(true);
}

function decode0f(rd: Reader, seg: number, sz: number, rep: number, done: (i: Omit<JInsn, "addr" | "next">) => JInsn, interp: (flow?: boolean) => JInsn): JInsn {
  const opc = rd.u8_();
  if (opc >= 0x80 && opc <= 0x8f) {
    const d = rd.s32();
    return done({ op: "jcc", sz, cc: opc & 15, target: (rd.pos + d) >>> 0, flow: true });
  }
  if (opc >= 0x40 && opc <= 0x4f) {
    const m = modrm(rd, seg);
    return done({ op: "cmov", sz, cc: opc & 15, a: R(m.reg, sz), b: rmOp(m, sz) });
  }
  if (opc >= 0x90 && opc <= 0x9f) {
    const m = modrm(rd, seg);
    return done({ op: "setcc", sz: 1, cc: opc & 15, a: rmOp(m, 1) });
  }
  if (opc >= 0xc8 && opc <= 0xcf) return done({ op: "bswap", sz: 4, a: R(opc & 7, 4) });
  switch (opc) {
    case 0xaf: {
      const m = modrm(rd, seg);
      return done({ op: "imul2", sz, a: R(m.reg, sz), b: rmOp(m, sz) });
    }
    case 0xb6: case 0xb7: case 0xbe: case 0xbf: {
      const ssz = opc & 1 ? 2 : 1;
      const m = modrm(rd, seg);
      return done({ op: opc < 0xbe ? "movzx" : "movsx", sz, a: R(m.reg, sz), b: rmOp(m, ssz) });
    }
    case 0xa3: case 0xab: case 0xb3: case 0xbb: {
      const m = modrm(rd, seg);
      if (m.mem) return interp(false);
      return done({ op: "bt", x: [0xa3, 0xab, 0xb3, 0xbb].indexOf(opc), sz, a: rmOp(m, sz), b: R(m.reg, sz) });
    }
    case 0xba: {
      const m = modrm(rd, seg);
      if (m.reg < 4) return interp(true);
      return done({ op: "bt", x: m.reg - 4, sz, a: rmOp(m, sz), b: I(rd.u8_(), 1) });
    }
    case 0xa4: case 0xa5: case 0xac: case 0xad: {
      const m = modrm(rd, seg);
      const count: Opnd = opc & 1 ? R(1, 1) : I(rd.u8_(), 1);
      return done({ op: opc < 0xac ? "shld" : "shrd", sz, a: rmOp(m, sz), b: R(m.reg, sz), c: count });
    }
    case 0xbc: case 0xbd: {
      const m = modrm(rd, seg);
      return done({ op: opc === 0xbc ? "bsf" : "bsr", sz, a: R(m.reg, sz), b: rmOp(m, sz) });
    }
    case 0xc0: case 0xc1: {
      const s = opc === 0xc0 ? 1 : sz;
      const m = modrm(rd, seg);
      return done({ op: "xadd", sz: s, a: rmOp(m, s), b: R(m.reg, s) });
    }
    case 0xb0: case 0xb1: {
      const s = opc === 0xb0 ? 1 : sz;
      const m = modrm(rd, seg);
      return done({ op: "cmpxchg", sz: s, a: rmOp(m, s), b: R(m.reg, s) });
    }
    case 0x77: return done({ op: "emms", sz: 8 });
    case 0x6e: {
      const m = modrm(rd, seg);
      return done({ op: "movd_to", sz: 8, x: m.reg, b: rmOp(m, 4) });
    }
    case 0x7e: {
      const m = modrm(rd, seg);
      return done({ op: "movd_from", sz: 8, x: m.reg, a: rmOp(m, 4) });
    }
    case 0x6f: {
      const m = modrm(rd, seg);
      return done({ op: "movq_to", sz: 8, x: m.reg, b: m.mem ? { t: "m", m: m.mem, sz: 8 } : R(m.rm, 8) });
    }
    case 0x7f: {
      const m = modrm(rd, seg);
      return done({ op: "movq_from", sz: 8, x: m.reg, a: m.mem ? { t: "m", m: m.mem, sz: 8 } : R(m.rm, 8) });
    }
    case 0x71: case 0x72: case 0x73: {
      const m = modrm(rd, seg);
      if (m.mem) return interp(true);
      return done({ op: "mmx_shi", sz: 8, x: opc, y: m.reg, a: R(m.rm, 8), b: I(rd.u8_(), 1) });
    }
  }
  if (rep === 0 && ((opc >= 0x60 && opc <= 0x6b) || (opc >= 0x74 && opc <= 0x76) || (opc >= 0xd1 && opc <= 0xfe))) {
    const m = modrm(rd, seg);
    return done({ op: "mmx", sz: 8, x: opc, y: m.reg, b: m.mem ? { t: "m", m: m.mem, sz: 8 } : R(m.rm, 8) });
  }
  return interp(true);
}

function decodeFpu(rd: Reader, opc: number, seg: number, done: (i: Omit<JInsn, "addr" | "next">) => JInsn, interp: (flow?: boolean) => JInsn): JInsn {
  const m = modrm(rd, seg);
  const g = opc - 0xd8;
  const memOp = (sz: number): Opnd => ({ t: "m", m: m.mem!, sz });
  if (m.mem) {
    switch (g) {
      case 0: return done({ op: "farith", x: m.reg, sz: 4, a: memOp(4), y: 0 });
      case 4: return done({ op: "farith", x: m.reg, sz: 8, a: memOp(8), y: 0 });
      case 2: return done({ op: "farith", x: m.reg, sz: 4, a: memOp(4), y: 1 });
      case 6: return done({ op: "farith", x: m.reg, sz: 2, a: memOp(2), y: 1 });
      case 1:
        if (m.reg === 0) return done({ op: "fld", sz: 4, a: memOp(4) });
        if (m.reg === 2 || m.reg === 3) return done({ op: "fst", sz: 4, a: memOp(4), x: m.reg - 2 });
        if (m.reg === 5) return done({ op: "fldcw", sz: 2, a: memOp(2) });
        if (m.reg === 7) return done({ op: "fnstcw", sz: 2, a: memOp(2) });
        return interp(false);
      case 5:
        if (m.reg === 0) return done({ op: "fld", sz: 8, a: memOp(8) });
        if (m.reg === 2 || m.reg === 3) return done({ op: "fst", sz: 8, a: memOp(8), x: m.reg - 2 });
        if (m.reg === 7) return done({ op: "fnstsw", sz: 2, a: memOp(2) });
        return interp(false);
      case 3:
        if (m.reg === 0) return done({ op: "fild", sz: 4, a: memOp(4) });
        if (m.reg === 2 || m.reg === 3) return done({ op: "fist", sz: 4, a: memOp(4), x: m.reg - 2 });
        return interp(false);
      case 7:
        if (m.reg === 0) return done({ op: "fild", sz: 2, a: memOp(2) });
        if (m.reg === 5) return done({ op: "fild", sz: 8, a: memOp(8) });
        if (m.reg === 2 || m.reg === 3) return done({ op: "fist", sz: 2, a: memOp(2), x: m.reg - 2 });
        if (m.reg === 7) return done({ op: "fist", sz: 8, a: memOp(8), x: 1 });
        return interp(false);
    }
    return interp(false);
  }
  const i = m.rm;
  switch (g) {
    case 0: return done({ op: "farith_st", x: m.reg, sz: 8, y: i });
    case 4: return done({ op: "farith_to", x: m.reg, sz: 8, y: i, c: I(0, 1) });
    case 6:
      if (m.reg === 3 && i === 1) return done({ op: "fcompp", sz: 8 });
      return done({ op: "farith_to", x: m.reg, sz: 8, y: i, c: I(1, 1) });
    case 1:
      if (m.reg === 0) return done({ op: "fld_st", sz: 8, y: i });
      if (m.reg === 1) return done({ op: "fxch", sz: 8, y: i });
      if (m.reg === 2 && i === 0) return done({ op: "nop", sz: 8 });
      if (m.reg === 4 && i === 0) return done({ op: "fchs", sz: 8 });
      if (m.reg === 4 && i === 1) return done({ op: "fabs", sz: 8 });
      if (m.reg === 4 && i === 4) return done({ op: "ftst", sz: 8 });
      if (m.reg === 5 && i !== 7) return done({ op: "fldc", sz: 8, y: i });
      if (m.reg === 7 && i === 2) return done({ op: "fsqrt", sz: 8 });
      return interp(false);
    case 5:
      if (m.reg === 2 || m.reg === 3) return done({ op: "fst_st", sz: 8, y: i, x: m.reg - 2 });
      if (m.reg === 0) return done({ op: "ffree", sz: 8, y: i });
      if (m.reg === 4 || m.reg === 5) return done({ op: "fucom", sz: 8, y: i, x: m.reg - 4 });
      return interp(false);
    case 2:
      if (m.reg === 5 && i === 1) return done({ op: "fucompp", sz: 8 });
      return interp(false);
    case 7:
      if (m.reg === 4 && i === 0) return done({ op: "fnstsw_ax", sz: 2 });
      return interp(false);
  }
  return interp(false);
}
