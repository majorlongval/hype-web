import { Code, I32, I64, F64, V128, Op, ModuleBuilder } from "./wasm";

import type { JInsn, Mem, Opnd } from "./x86";
import {
  ST_FLAGS, ST_LFA, ST_LFB, ST_LFCIN, ST_LFOF, ST_LFOP, ST_LFRES, ST_LFSZ, ST_SEGBASE, ST_FPU_TOP, ST_FPU_CW, ST_FPU_SW,
  ST_FPU_EMPTY, ST_FPU_ST, ST_MMX,
} from "../state";
import { LF_ADC, LF_ADD, LF_DEC, LF_EAGER, LF_INC, LF_LOGIC, LF_NEG, LF_NONE, LF_SBB, LF_SUB } from "../cpu";

export interface RBlock {
  start: number;
  end: number;
  insns: JInsn[];
}

export interface Region {
  entry: number;
  blocks: RBlock[];
}

/** Indices of functions and globals every region module imports, in import order. */
export const IMP_INTERP = 0, IMP_COND = 1, IMP_FLAGS = 2;
export const G_BUDGET = 0, G_RESUME = 1, G_FORCE = 2;

type FState = { k: "mem" } | { k: "lazy"; op: number; sz: number } | { k: "word" };

const MASKS = [0, 0xff, 0xffff, 0, -1];
const SIGNS = [0, 0x80, 0x8000, 0, 0x80000000 | 0];
const C0 = 0x100, C2 = 0x400, C3 = 0x4000;

const FLDC = [1, Math.log2(10), Math.LOG2E, Math.PI, Math.log10(2), Math.LN2, 0];

export class RegionCompiler {
  private c = new Code(1);
  private R: number[] = [];
  private NEXT: number;
  private FA: number;
  private FB: number;
  private FRES: number;
  private FCIN: number;
  private FOF: number;
  private FW: number;
  private T: number[] = [];
  private EA: number;
  private L0: number;
  private L1: number;
  private D0: number;
  private D1: number;
  private TOP: number;
  private V0: number;
  private V1: number;
  private labels: string[] = [];
  private fs: FState = { k: "mem" };
  private index = new Map<number, number>();
  private cur = 0;
  private usesSimd = false;

  constructor(private region: Region, private sb: number) {
    const c = this.c;
    for (let i = 0; i < 8; i++) this.R.push(c.local(I32));
    this.NEXT = c.local(I32);
    this.FA = c.local(I32);
    this.FB = c.local(I32);
    this.FRES = c.local(I32);
    this.FCIN = c.local(I32);
    this.FOF = c.local(I32);
    this.FW = c.local(I32);
    for (let i = 0; i < 6; i++) this.T.push(c.local(I32));
    this.EA = c.local(I32);
    this.TOP = c.local(I32);
    this.L0 = c.local(I64);
    this.L1 = c.local(I64);
    this.D0 = c.local(F64);
    this.D1 = c.local(F64);
    this.V0 = c.local(V128);
    this.V1 = c.local(V128);
    region.blocks.forEach((b, i) => this.index.set(b.start, i));
  }

  // ---------- module ----------

  static module(regions: RegionCompiler[], pages: number): Uint8Array {
    const mb = new ModuleBuilder();
    mb.importMemory("e", "m", pages);
    mb.importGlobal("e", "budget", I32, true);
    mb.importGlobal("e", "resume", I32, true);
    mb.importGlobal("e", "force", I32, true);
    mb.importFunc("e", "interp", [I32], [I32]);
    mb.importFunc("e", "cond", [I32], [I32]);
    mb.importFunc("e", "flags", [], [I32]);
    regions.forEach((r, i) => {
      const f = mb.func([I32], [I32], r.compile());
      mb.exportFunc(`r${i}`, f);
    });
    return mb.build();
  }

  // ---------- labels ----------

  private open(kind: "block" | "loop" | "if", label: string): void {
    const c = this.c;
    if (kind === "block") c.block();
    else if (kind === "loop") c.loop();
    else c.if_();
    this.labels.push(label);
  }
  private close(): void {
    this.c.end();
    this.labels.pop();
  }
  private depth(label: string): number {
    for (let i = this.labels.length - 1; i >= 0; i--) if (this.labels[i] === label) return this.labels.length - 1 - i;
    throw new Error(`label ${label} not open`);
  }

  // ---------- body ----------

  compile(): Uint8Array {
    const c = this.c, sb = this.sb, blocks = this.region.blocks;
    for (let i = 0; i < 8; i++) c.i32(0).mem(Op.i32_load, sb + i * 4, 2).set(this.R[i]);
    this.open("loop", "L");
    this.open("block", "exit");
    for (let i = blocks.length - 1; i >= 0; i--) this.open("block", `B${i}`);
    c.get(0).op(Op.br_table).u32(blocks.length);
    for (let i = 0; i < blocks.length; i++) c.u32(i);
    c.u32(blocks.length);
    for (let i = 0; i < blocks.length; i++) {
      this.close();
      this.cur = i;
      this.block(blocks[i]);
    }
    this.close();
    for (let i = 0; i < 8; i++) c.i32(0).get(this.R[i]).mem(Op.i32_store, sb + i * 4, 2);
    c.get(this.NEXT).op(Op.return_);
    this.close();
    c.op(Op.unreachable);
    return c.finish();
  }

  private block(b: RBlock): void {
    const c = this.c;
    this.fs = { k: "mem" };
    c.gget(G_BUDGET).i32(b.insns.length).op(Op.i32_sub).gset(G_BUDGET).gget(G_BUDGET).i32(0).op(Op.i32_lt_s);
    this.open("if", "budget");
    this.exitConst(b.start);
    this.close();
    let ended = false;
    for (const insn of b.insns) {
      ended = this.insn(insn);
      if (ended) break;
    }
    if (!ended) {
      this.storeFlags();
      this.branchTo(b.end);
    }
  }

  // ---------- control transfer ----------

  private branchTo(eip: number): void {
    const j = this.index.get(eip);
    if (j === undefined) return this.exitConst(eip);
    if (j > this.cur) {
      this.c.br(this.depth(`B${j}`));
      return;
    }
    this.c.i32(j).set(0).br(this.depth("L"));
  }

  /** Leaves the region at a constant eip. Flags must already be stored. */
  private exitConst(eip: number): void {
    this.c.i32(eip | 0).set(this.NEXT).br(this.depth("exit"));
  }

  /** Leaves the region at the eip on the stack. */
  private exitDyn(): void {
    this.c.set(this.NEXT).br(this.depth("exit"));
  }

  /** Exits so the interpreter runs the instruction at addr (used inside conditionals; keeps the compile-time flag state). */
  private forceInterp(addr: number): void {
    const saved = this.fs;
    this.storeFlags();
    this.fs = saved;
    this.c.i32(1).gset(G_FORCE);
    this.exitConst(addr);
  }

  // ---------- state flush ----------

  private storeRegs(): void {
    for (let i = 0; i < 8; i++) this.c.i32(0).get(this.R[i]).mem(Op.i32_store, this.sb + i * 4, 2);
  }
  private loadRegs(): void {
    for (let i = 0; i < 8; i++) this.c.i32(0).mem(Op.i32_load, this.sb + i * 4, 2).set(this.R[i]);
  }

  private st32(off: number, push: () => void): void {
    this.c.i32(0);
    push();
    this.c.mem(Op.i32_store, this.sb + off, 2);
  }

  /** Writes the compile-time flag state into the interpreter's lazy-flag record. */
  private storeFlags(): void {
    const fs = this.fs, c = this.c;
    if (fs.k === "mem") return;
    if (fs.k === "word") {
      this.st32(ST_FLAGS, () => c.get(this.FW));
      this.st32(ST_LFOP, () => c.i32(LF_NONE));
    } else {
      const op = fs.op;
      this.st32(ST_LFOP, () => c.i32(op));
      this.st32(ST_LFRES, () => c.get(this.FRES));
      this.st32(ST_LFSZ, () => c.i32(fs.sz));
      if (op === LF_ADD || op === LF_ADC || op === LF_SUB || op === LF_SBB) {
        this.st32(ST_LFA, () => c.get(this.FA));
        this.st32(ST_LFB, () => c.get(this.FB));
      }
      if (op === LF_ADC || op === LF_SBB || op === LF_INC || op === LF_DEC || op === LF_EAGER) this.st32(ST_LFCIN, () => c.get(this.FCIN));
      if (op === LF_EAGER) this.st32(ST_LFOF, () => c.get(this.FOF));
    }
    this.fs = { k: "mem" };
  }

  /** Puts the full EFLAGS value in FW and switches to word state. */
  private toWord(): void {
    if (this.fs.k === "word") return;
    this.storeFlags();
    this.c.call(IMP_FLAGS).set(this.FW);
    this.fs = { k: "word" };
  }

  // ---------- flags ----------

  private signBit(sz: number, local: number): void {
    const c = this.c;
    if (sz === 4) c.get(local).i32(31).op(Op.i32_shr_u);
    else c.get(local).i32(sz * 8 - 1).op(Op.i32_shr_u).i32(1).op(Op.i32_and);
  }

  /** Pushes CF (0/1). */
  private cf(): void {
    const c = this.c, fs = this.fs;
    if (fs.k === "mem") { c.i32(2).call(IMP_COND); return; }
    if (fs.k === "word") { c.get(this.FW).i32(1).op(Op.i32_and); return; }
    switch (fs.op) {
      case LF_ADD: c.get(this.FRES).get(this.FA).op(Op.i32_lt_u); return;
      case LF_SUB: c.get(this.FA).get(this.FB).op(Op.i32_lt_u); return;
      case LF_ADC:
        c.get(this.FRES).get(this.FA).op(Op.i32_le_u).get(this.FRES).get(this.FA).op(Op.i32_lt_u).get(this.FCIN).op(Op.select);
        return;
      case LF_SBB:
        c.get(this.FA).get(this.FB).op(Op.i32_le_u).get(this.FA).get(this.FB).op(Op.i32_lt_u).get(this.FCIN).op(Op.select);
        return;
      case LF_LOGIC: c.i32(0); return;
      case LF_NEG: c.get(this.FRES).i32(0).op(Op.i32_ne); return;
      default: c.get(this.FCIN); return;
    }
  }
  private zf(): void {
    const c = this.c, fs = this.fs;
    if (fs.k === "lazy") c.get(this.FRES).op(Op.i32_eqz);
    else if (fs.k === "word") c.get(this.FW).i32(6).op(Op.i32_shr_u).i32(1).op(Op.i32_and);
    else c.i32(4).call(IMP_COND);
  }
  private sf(): void {
    const fs = this.fs;
    if (fs.k === "lazy") this.signBit(fs.sz, this.FRES);
    else if (fs.k === "word") this.c.get(this.FW).i32(7).op(Op.i32_shr_u).i32(1).op(Op.i32_and);
    else this.c.i32(8).call(IMP_COND);
  }
  private pf(): void {
    const c = this.c, fs = this.fs;
    if (fs.k === "lazy") c.get(this.FRES).i32(0xff).op(Op.i32_and).op(Op.i32_popcnt).i32(1).op(Op.i32_and).op(Op.i32_eqz);
    else if (fs.k === "word") c.get(this.FW).i32(2).op(Op.i32_shr_u).i32(1).op(Op.i32_and);
    else c.i32(10).call(IMP_COND);
  }
  private of(): void {
    const c = this.c, fs = this.fs;
    if (fs.k === "mem") { c.i32(0).call(IMP_COND); return; }
    if (fs.k === "word") { c.get(this.FW).i32(11).op(Op.i32_shr_u).i32(1).op(Op.i32_and); return; }
    const s = SIGNS[fs.sz];
    switch (fs.op) {
      case LF_ADD: case LF_ADC:
        c.get(this.FA).get(this.FRES).op(Op.i32_xor).get(this.FB).get(this.FRES).op(Op.i32_xor).op(Op.i32_and).i32(s).op(Op.i32_and).i32(0).op(Op.i32_ne);
        return;
      case LF_SUB: case LF_SBB:
        c.get(this.FA).get(this.FB).op(Op.i32_xor).get(this.FA).get(this.FRES).op(Op.i32_xor).op(Op.i32_and).i32(s).op(Op.i32_and).i32(0).op(Op.i32_ne);
        return;
      case LF_LOGIC: c.i32(0); return;
      case LF_INC: case LF_NEG: c.get(this.FRES).i32(s).op(Op.i32_eq); return;
      case LF_DEC: c.get(this.FRES).i32((s - 1) | 0).op(Op.i32_eq); return;
      default: c.get(this.FOF); return;
    }
  }

  /** Pushes the truth value (0/1) of condition code cc. */
  private cond(cc: number): void {
    const c = this.c, fs = this.fs;
    if (fs.k === "mem") { c.i32(cc).call(IMP_COND); return; }
    const neg = cc & 1;
    const base = cc & ~1;
    if (fs.k === "lazy" && fs.op === LF_SUB && (base === 2 || base === 6 || base === 12 || base === 14)) {
      const sh = 32 - fs.sz * 8;
      const pushAB = (signed: boolean) => {
        if (signed && sh) {
          c.get(this.FA).i32(sh).op(Op.i32_shl).get(this.FB).i32(sh).op(Op.i32_shl);
        } else c.get(this.FA).get(this.FB);
      };
      if (base === 2) { pushAB(false); c.op(neg ? Op.i32_ge_u : Op.i32_lt_u); return; }
      if (base === 6) { pushAB(false); c.op(neg ? Op.i32_gt_u : Op.i32_le_u); return; }
      if (base === 12) { pushAB(true); c.op(neg ? Op.i32_ge_s : Op.i32_lt_s); return; }
      pushAB(true);
      c.op(neg ? Op.i32_gt_s : Op.i32_le_s);
      return;
    }
    if (fs.k === "lazy" && fs.op === LF_LOGIC) {
      switch (base) {
        case 0: case 2: c.i32(neg); return;
        case 6: this.zf(); break;
        case 12: this.sf(); break;
        case 14: this.zf(); this.sf(); c.op(Op.i32_or); break;
        default: this.flagFor(base);
      }
      if (neg) c.op(Op.i32_eqz);
      return;
    }
    switch (base) {
      case 6: this.cf(); this.zf(); c.op(Op.i32_or); break;
      case 12: this.sf(); this.of(); c.op(Op.i32_xor); break;
      case 14: this.zf(); this.sf(); this.of(); c.op(Op.i32_xor).op(Op.i32_or); break;
      default: this.flagFor(base);
    }
    if (neg) c.op(Op.i32_eqz);
  }
  private flagFor(base: number): void {
    if (base === 0) this.of();
    else if (base === 2) this.cf();
    else if (base === 4) this.zf();
    else if (base === 8) this.sf();
    else this.pf();
  }

  private setLazy(op: number, sz: number): void {
    this.fs = { k: "lazy", op, sz };
  }

  // ---------- operands ----------

  private ea(m: Mem): void {
    const c = this.c;
    let any = false;
    if (m.base >= 0) { c.get(this.R[m.base]); any = true; }
    if (m.index >= 0) {
      c.get(this.R[m.index]);
      if (m.scale) c.i32(m.scale).op(Op.i32_shl);
      if (any) c.op(Op.i32_add);
      any = true;
    }
    if (m.disp || !any) {
      c.i32(m.disp);
      if (any) c.op(Op.i32_add);
    }
    if (m.seg >= 0) c.i32(0).mem(Op.i32_load, this.sb + ST_SEGBASE + m.seg * 4, 2).op(Op.i32_add);
  }

  /** Computes the operand's effective address into EA if it is a memory operand. */
  private prep(o: Opnd | undefined): void {
    if (o && o.t === "m") {
      this.ea(o.m);
      this.c.set(this.EA);
    }
  }

  private load(sz: number): void {
    const c = this.c;
    if (sz === 1) c.mem(Op.i32_load8_u);
    else if (sz === 2) c.mem(Op.i32_load16_u);
    else c.mem(Op.i32_load);
  }
  private store(sz: number): void {
    const c = this.c;
    if (sz === 1) c.mem(Op.i32_store8);
    else if (sz === 2) c.mem(Op.i32_store16);
    else c.mem(Op.i32_store);
  }

  /** Pushes the operand's value, zero-extended. Memory operands must be prepped. */
  private read(o: Opnd): void {
    const c = this.c;
    if (o.t === "i") {
      c.i32(o.v & MASKS[o.sz]);
      return;
    }
    if (o.t === "m") {
      c.get(this.EA);
      this.load(o.sz);
      return;
    }
    if (o.sz === 4) c.get(this.R[o.r]);
    else if (o.sz === 2) c.get(this.R[o.r]).i32(0xffff).op(Op.i32_and);
    else if (o.r < 4) c.get(this.R[o.r]).i32(0xff).op(Op.i32_and);
    else c.get(this.R[o.r - 4]).i32(8).op(Op.i32_shr_u).i32(0xff).op(Op.i32_and);
  }

  /** Writes local `v` to the operand. */
  private write(o: Opnd, v: number): void {
    const c = this.c;
    if (o.t === "m") {
      c.get(this.EA).get(v);
      this.store(o.sz);
      return;
    }
    if (o.t !== "r") throw new Error("write to immediate");
    if (o.sz === 4) { c.get(v).set(this.R[o.r]); return; }
    if (o.sz === 2) {
      c.get(this.R[o.r]).i32(-65536).op(Op.i32_and).get(v).i32(0xffff).op(Op.i32_and).op(Op.i32_or).set(this.R[o.r]);
      return;
    }
    if (o.r < 4) {
      c.get(this.R[o.r]).i32(~0xff).op(Op.i32_and).get(v).i32(0xff).op(Op.i32_and).op(Op.i32_or).set(this.R[o.r]);
      return;
    }
    const r = this.R[o.r - 4];
    c.get(r).i32(~0xff00).op(Op.i32_and).get(v).i32(0xff).op(Op.i32_and).i32(8).op(Op.i32_shl).op(Op.i32_or).set(r);
  }

  private mask(sz: number): void {
    if (sz !== 4) this.c.i32(MASKS[sz]).op(Op.i32_and);
  }

  private push(v: number, sz: number): void {
    const c = this.c, esp = this.R[4];
    c.get(esp).i32(sz).op(Op.i32_sub).tee(esp).get(v);
    this.store(sz);
  }

  // ---------- fallback ----------

  private fallback(insn: JInsn): void {
    const c = this.c;
    this.storeFlags();
    this.storeRegs();
    c.i32(insn.addr | 0).gset(G_RESUME);
    c.i32(insn.addr | 0).call(IMP_INTERP).set(this.NEXT);
    this.loadRegs();
    c.i32(insn.next | 0).gset(G_RESUME);
  }

  // ---------- instructions ----------

  /** Emits one instruction; returns true when it ended the block. */
  private insn(i: JInsn): boolean {
    const c = this.c, T = this.T;
    switch (i.op) {
      case "nop": return false;
      case "mov": {
        this.prep(i.a);
        this.prep(i.b);
        this.read(i.b!);
        c.set(T[0]);
        this.write(i.a!, T[0]);
        return false;
      }
      case "movzx": case "movsx": {
        this.prep(i.b);
        this.read(i.b!);
        if (i.op === "movsx") c.op(i.b!.sz === 1 ? Op.i32_extend8_s : Op.i32_extend16_s);
        if (i.sz === 2) c.i32(0xffff).op(Op.i32_and);
        c.set(T[0]);
        this.write(i.a!, T[0]);
        return false;
      }
      case "lea": {
        const m = (i.b as { m: Mem }).m;
        this.ea({ ...m, seg: -1 });
        c.set(T[0]);
        this.write(i.a!, T[0]);
        return false;
      }
      case "alu": return this.alu(i);
      case "test": {
        this.prep(i.a);
        this.read(i.a!);
        this.read(i.b!);
        c.op(Op.i32_and).set(this.FRES);
        this.setLazy(LF_LOGIC, i.sz);
        return false;
      }
      case "inc": case "dec": {
        this.prep(i.a);
        this.cf();
        c.set(this.FCIN);
        this.read(i.a!);
        c.tee(this.FA).i32(1).op(i.op === "inc" ? Op.i32_add : Op.i32_sub);
        this.mask(i.sz);
        c.set(this.FRES).i32(1).set(this.FB);
        this.write(i.a!, this.FRES);
        this.setLazy(i.op === "inc" ? LF_INC : LF_DEC, i.sz);
        return false;
      }
      case "neg": {
        this.prep(i.a);
        c.i32(0).set(this.FA);
        this.read(i.a!);
        c.set(this.FB).i32(0).get(this.FB).op(Op.i32_sub);
        this.mask(i.sz);
        c.set(this.FRES);
        this.write(i.a!, this.FRES);
        this.setLazy(LF_NEG, i.sz);
        return false;
      }
      case "not": {
        this.prep(i.a);
        this.read(i.a!);
        c.i32(-1).op(Op.i32_xor);
        this.mask(i.sz);
        c.set(T[0]);
        this.write(i.a!, T[0]);
        return false;
      }
      case "xchg": {
        this.prep(i.a);
        this.read(i.a!);
        c.set(T[0]);
        this.read(i.b!);
        c.set(T[1]);
        this.write(i.a!, T[1]);
        this.write(i.b!, T[0]);
        return false;
      }
      case "push": {
        this.prep(i.a);
        this.read(i.a!);
        c.set(T[0]);
        this.push(T[0], i.sz);
        return false;
      }
      case "pop": {
        const esp = this.R[4];
        c.get(esp);
        this.load(i.sz);
        c.set(T[0]).get(esp).i32(i.sz).op(Op.i32_add).set(esp);
        this.prep(i.a);
        this.write(i.a!, T[0]);
        return false;
      }
      case "leave": {
        const esp = this.R[4], ebp = this.R[5];
        c.get(ebp).tee(esp);
        this.load(i.sz);
        c.set(T[0]).get(esp).i32(i.sz).op(Op.i32_add).set(esp);
        this.write({ t: "r", r: 5, sz: i.sz }, T[0]);
        void ebp;
        return false;
      }
      case "cdq": case "cwd": {
        if (i.sz === 4) c.get(this.R[0]).i32(31).op(Op.i32_shr_s).set(this.R[2]);
        else {
          c.get(this.R[0]).op(Op.i32_extend16_s).i32(16).op(Op.i32_shr_s).set(T[0]);
          this.write({ t: "r", r: 2, sz: 2 }, T[0]);
        }
        return false;
      }
      case "cwde": c.get(this.R[0]).op(Op.i32_extend16_s).set(this.R[0]); return false;
      case "cbw": {
        c.get(this.R[0]).op(Op.i32_extend8_s).set(T[0]);
        this.write({ t: "r", r: 0, sz: 2 }, T[0]);
        return false;
      }
      case "bswap": {
        const r = this.R[i.a!.t === "r" ? i.a!.r : 0];
        c.get(r).i32(24).op(Op.i32_shl)
          .get(r).i32(0xff00).op(Op.i32_and).i32(8).op(Op.i32_shl).op(Op.i32_or)
          .get(r).i32(8).op(Op.i32_shr_u).i32(0xff00).op(Op.i32_and).op(Op.i32_or)
          .get(r).i32(24).op(Op.i32_shr_u).op(Op.i32_or).set(r);
        return false;
      }
      case "setcc": {
        this.prep(i.a);
        this.cond(i.cc!);
        c.set(T[0]);
        this.write(i.a!, T[0]);
        return false;
      }
      case "cmov": {
        this.prep(i.b);
        this.read(i.b!);
        c.set(T[0]);
        this.cond(i.cc!);
        this.open("if", "cmov");
        this.write(i.a!, T[0]);
        this.close();
        return false;
      }
      case "imul2": case "imul3": return this.imul23(i);
      case "mul": case "imul1": case "div": case "idiv": return this.muldiv(i);
      case "shift": return this.shift(i);
      case "sahf": {
        this.toWord();
        c.get(this.FW).i32(~0xd5).op(Op.i32_and).get(this.R[0]).i32(8).op(Op.i32_shr_u).i32(0xd5).op(Op.i32_and).op(Op.i32_or).set(this.FW);
        return false;
      }
      case "lahf": {
        this.toWord();
        c.get(this.FW).i32(0xd5).op(Op.i32_and).i32(2).op(Op.i32_or).set(T[0]);
        this.write({ t: "r", r: 4, sz: 1 }, T[0]);
        return false;
      }
      case "clc": case "stc": case "cmc": {
        this.toWord();
        if (i.op === "clc") c.get(this.FW).i32(~1).op(Op.i32_and);
        else c.get(this.FW).i32(1).op(i.op === "stc" ? Op.i32_or : Op.i32_xor);
        c.set(this.FW);
        return false;
      }
      case "cld": case "std": {
        if (this.fs.k === "word") {
          c.get(this.FW).i32(~0x400).op(Op.i32_and);
          if (i.op === "std") c.i32(0x400).op(Op.i32_or);
          c.set(this.FW);
        } else {
          c.i32(0).i32(0).mem(Op.i32_load, this.sb + ST_FLAGS, 2).i32(~0x400).op(Op.i32_and);
          if (i.op === "std") c.i32(0x400).op(Op.i32_or);
          c.mem(Op.i32_store, this.sb + ST_FLAGS, 2);
        }
        return false;
      }
      case "bt": return this.bt(i);
      case "bsf": case "bsr": {
        this.prep(i.b);
        this.read(i.b!);
        c.set(T[0]);
        this.toWord();
        c.get(T[0]).op(Op.i32_eqz);
        this.open("if", "bs");
        c.get(this.FW).i32(0x40).op(Op.i32_or).set(this.FW);
        c.else_();
        c.get(this.FW).i32(~0x40).op(Op.i32_and).set(this.FW);
        if (i.op === "bsf") c.get(T[0]).op(Op.i32_ctz);
        else c.i32(31).get(T[0]).op(Op.i32_clz).op(Op.i32_sub);
        c.set(T[1]);
        this.write(i.a!, T[1]);
        this.close();
        return false;
      }
      case "xadd": {
        this.prep(i.a);
        this.read(i.a!);
        c.tee(this.FA);
        this.read(i.b!);
        c.tee(this.FB).op(Op.i32_add);
        this.mask(i.sz);
        c.set(this.FRES);
        this.write(i.b!, this.FA);
        this.write(i.a!, this.FRES);
        this.setLazy(LF_ADD, i.sz);
        return false;
      }
      case "cmpxchg": {
        this.prep(i.a);
        this.read({ t: "r", r: 0, sz: i.sz });
        c.tee(this.FA);
        this.read(i.a!);
        c.tee(this.FB).op(Op.i32_sub);
        this.mask(i.sz);
        c.set(this.FRES);
        this.setLazy(LF_SUB, i.sz);
        c.get(this.FRES).op(Op.i32_eqz);
        this.open("if", "cx");
        this.read(i.b!);
        c.set(T[0]);
        this.write(i.a!, T[0]);
        c.else_();
        this.write({ t: "r", r: 0, sz: i.sz }, this.FB);
        this.close();
        return false;
      }
      case "jcc": {
        this.cond(i.cc!);
        c.set(T[0]);
        this.storeFlags();
        c.get(T[0]);
        this.open("if", "jcc");
        this.branchTo(i.target!);
        this.close();
        this.branchTo(i.next);
        return true;
      }
      case "loop": case "loope": case "loopne": case "jecxz": {
        const ecx = this.R[1];
        if (i.op === "jecxz") c.get(ecx).op(Op.i32_eqz);
        else {
          c.get(ecx).i32(1).op(Op.i32_sub).tee(ecx).i32(0).op(Op.i32_ne);
          if (i.op !== "loop") {
            this.zf();
            if (i.op === "loopne") c.op(Op.i32_eqz);
            c.op(Op.i32_and);
          }
        }
        c.set(T[0]);
        this.storeFlags();
        c.get(T[0]);
        this.open("if", "loop");
        this.branchTo(i.target!);
        this.close();
        this.branchTo(i.next);
        return true;
      }
      case "jmp": {
        this.storeFlags();
        this.branchTo(i.target!);
        return true;
      }
      case "call": {
        this.storeFlags();
        c.i32(i.next | 0).set(T[0]);
        this.push(T[0], 4);
        this.exitConst(i.target!);
        return true;
      }
      case "calli": {
        this.prep(i.a);
        this.read(i.a!);
        c.set(T[1]);
        this.storeFlags();
        c.i32(i.next | 0).set(T[0]);
        this.push(T[0], 4);
        c.get(T[1]);
        this.exitDyn();
        return true;
      }
      case "jmpi": {
        this.prep(i.a);
        this.read(i.a!);
        c.set(T[1]);
        this.storeFlags();
        c.get(T[1]);
        this.exitDyn();
        return true;
      }
      case "ret": {
        const esp = this.R[4];
        this.storeFlags();
        c.get(esp).mem(Op.i32_load).set(T[0]).get(esp).i32(4 + (i.x ?? 0)).op(Op.i32_add).set(esp).get(T[0]);
        this.exitDyn();
        return true;
      }
      case "emms":
        c.i32(0).i64(0x0101010101010101n).mem(Op.i64_store, this.sb + ST_FPU_EMPTY);
        return false;
      default:
        if (i.op.startsWith("f")) {
          const r = this.fpu(i);
          if (r !== null) return r;
        } else if (i.op.startsWith("m")) {
          const r = this.mmx(i);
          if (r !== null) return r;
        }
        this.fallback(i);
        if (i.flow) {
          c.get(this.NEXT);
          this.exitDyn();
          return true;
        }
        c.get(this.NEXT).i32(i.next | 0).op(Op.i32_ne);
        this.open("if", "redirect");
        c.get(this.NEXT);
        this.exitDyn();
        this.close();
        return false;
    }
  }

  private alu(i: JInsn): boolean {
    const c = this.c, x = i.x!, sz = i.sz;
    this.prep(i.a);
    this.prep(i.b);
    if (x === 2 || x === 3) {
      this.cf();
      c.set(this.FCIN);
    }
    this.read(i.a!);
    c.set(this.FA);
    this.read(i.b!);
    c.set(this.FB);
    c.get(this.FA).get(this.FB);
    switch (x) {
      case 0: c.op(Op.i32_add); break;
      case 1: c.op(Op.i32_or); break;
      case 2: c.op(Op.i32_add).get(this.FCIN).op(Op.i32_add); break;
      case 3: c.op(Op.i32_sub).get(this.FCIN).op(Op.i32_sub); break;
      case 4: c.op(Op.i32_and); break;
      case 6: c.op(Op.i32_xor); break;
      default: c.op(Op.i32_sub); break;
    }
    this.mask(sz);
    c.set(this.FRES);
    if (x !== 7) this.write(i.a!, this.FRES);
    this.setLazy([LF_ADD, LF_LOGIC, LF_ADC, LF_SBB, LF_LOGIC, LF_SUB, LF_LOGIC, LF_SUB][x], sz);
    return false;
  }

  private setEagerFrom(sz: number): void {
    this.setLazy(LF_EAGER, sz);
  }

  private imul23(i: JInsn): boolean {
    const c = this.c, sz = i.sz;
    const src1 = i.op === "imul2" ? i.a! : i.b!;
    const src2 = i.op === "imul2" ? i.b! : i.c!;
    this.prep(src1.t === "m" ? src1 : src2);
    this.read(src1);
    if (sz === 2) c.op(Op.i32_extend16_s);
    c.op(Op.i64_extend_i32_s);
    this.read(src2);
    if (sz === 2) c.op(Op.i32_extend16_s);
    c.op(Op.i64_extend_i32_s).op(Op.i64_mul).tee(this.L0).op(Op.i32_wrap_i64);
    this.mask(sz);
    c.set(this.FRES);
    c.get(this.FRES);
    if (sz === 2) c.op(Op.i32_extend16_s);
    c.op(Op.i64_extend_i32_s).get(this.L0).op(Op.i64_ne).tee(this.FCIN).set(this.FOF);
    this.write(i.a!, this.FRES);
    this.setEagerFrom(sz);
    return false;
  }

  private muldiv(i: JInsn): boolean {
    const c = this.c, T = this.T, sz = i.sz;
    if (sz !== 4) {
      this.fallback(i);
      return false;
    }
    const eax = this.R[0], edx = this.R[2];
    this.prep(i.a);
    this.read(i.a!);
    c.set(T[0]);
    if (i.op === "mul" || i.op === "imul1") {
      const ext = i.op === "mul" ? Op.i64_extend_i32_u : Op.i64_extend_i32_s;
      c.get(eax).op(ext).get(T[0]).op(ext).op(Op.i64_mul).tee(this.L0).op(Op.i32_wrap_i64).tee(eax).set(this.FRES);
      c.get(this.L0).i64(32n).op(Op.i64_shr_u).op(Op.i32_wrap_i64).set(edx);
      if (i.op === "mul") c.get(edx).i32(0).op(Op.i32_ne);
      else c.get(edx).get(eax).i32(31).op(Op.i32_shr_s).op(Op.i32_ne);
      c.tee(this.FCIN).set(this.FOF);
      this.setEagerFrom(4);
      return false;
    }
    c.get(edx).op(Op.i64_extend_i32_u).i64(32n).op(Op.i64_shl).get(eax).op(Op.i64_extend_i32_u).op(Op.i64_or).set(this.L0);
    if (i.op === "div") {
      c.get(T[0]).op(Op.i32_eqz).get(edx).get(T[0]).op(Op.i32_ge_u).op(Op.i32_or);
      this.open("if", "de");
      this.forceInterp(i.addr);
      this.close();
      c.get(T[0]).op(Op.i64_extend_i32_u).set(this.L1);
      c.get(this.L0).get(this.L1).op(Op.i64_div_u).op(Op.i32_wrap_i64).set(T[1]);
      c.get(this.L0).get(this.L1).op(Op.i64_rem_u).op(Op.i32_wrap_i64).set(edx);
      c.get(T[1]).set(eax);
      return false;
    }
    c.get(T[0]).op(Op.i32_eqz);
    c.get(T[0]).i32(-1).op(Op.i32_eq).get(this.L0).i64(-0x8000000000000000n).op(Op.i64_eq).op(Op.i32_and).op(Op.i32_or);
    this.open("if", "de");
    this.forceInterp(i.addr);
    this.close();
    c.get(T[0]).op(Op.i64_extend_i32_s).set(this.L1);
    c.get(this.L0).get(this.L1).op(Op.i64_div_s).tee(this.L0).get(this.L0).op(Op.i32_wrap_i64).op(Op.i64_extend_i32_s).op(Op.i64_ne);
    this.open("if", "de2");
    this.forceInterp(i.addr);
    this.close();
    c.get(edx).op(Op.i64_extend_i32_u).i64(32n).op(Op.i64_shl).get(eax).op(Op.i64_extend_i32_u).op(Op.i64_or).get(this.L1).op(Op.i64_rem_s).op(Op.i32_wrap_i64).set(edx);
    c.get(this.L0).op(Op.i32_wrap_i64).set(eax);
    return false;
  }

  private shift(i: JInsn): boolean {
    const c = this.c, T = this.T, sz = i.sz, x = i.x!, bits = sz * 8;
    if (x === 2 || x === 3) {
      this.fallback(i);
      return false;
    }
    const s = SIGNS[sz];
    this.prep(i.a);
    if (i.b!.t === "i") {
      const n = i.b!.v & 31;
      if (n === 0) return false;
      this.read(i.a!);
      c.set(T[0]);
      if (x === 0 || x === 1) {
        const k = n % bits;
        this.toWord();
        if (k === 0) c.get(T[0]).set(T[1]);
        else if (sz === 4) c.get(T[0]).i32(k).op(x === 0 ? Op.i32_rotl : Op.i32_rotr).set(T[1]);
        else {
          const l = x === 0 ? k : bits - k;
          c.get(T[0]).i32(l).op(Op.i32_shl).get(T[0]).i32(bits - l).op(Op.i32_shr_u).op(Op.i32_or);
          this.mask(sz);
          c.set(T[1]);
        }
        if (x === 0) {
          c.get(T[1]).i32(1).op(Op.i32_and).set(T[2]);
          this.signBit(sz, T[1]);
          c.get(T[2]).op(Op.i32_xor).set(T[3]);
        } else {
          this.signBit(sz, T[1]);
          c.tee(T[2]);
          c.get(T[1]).i32(bits - 2).op(Op.i32_shr_u).i32(1).op(Op.i32_and).op(Op.i32_xor).set(T[3]);
        }
        c.get(this.FW).i32(~0x801).op(Op.i32_and).get(T[2]).op(Op.i32_or).get(T[3]).i32(11).op(Op.i32_shl).op(Op.i32_or).set(this.FW);
        this.write(i.a!, T[1]);
        return false;
      }
      if (x === 4 || x === 6) {
        c.get(T[0]).i32(n).op(Op.i32_shl);
        this.mask(sz);
        c.set(this.FRES);
        if (n <= bits) c.get(T[0]).i32(bits - n).op(Op.i32_shr_u).i32(1).op(Op.i32_and);
        else c.i32(0);
        c.set(this.FCIN);
        this.signBit(sz, this.FRES);
        c.get(this.FCIN).op(Op.i32_xor).set(this.FOF);
      } else if (x === 5) {
        c.get(T[0]).i32(n).op(Op.i32_shr_u).set(this.FRES);
        c.get(T[0]).i32(n - 1).op(Op.i32_shr_u).i32(1).op(Op.i32_and).set(this.FCIN);
        if (n === 1) this.signBit(sz, T[0]);
        else c.i32(0);
        c.set(this.FOF);
      } else {
        c.get(T[0]);
        if (sz === 1) c.op(Op.i32_extend8_s);
        else if (sz === 2) c.op(Op.i32_extend16_s);
        c.set(T[1]);
        c.get(T[1]).i32(Math.min(n, bits - 1)).op(Op.i32_shr_s);
        this.mask(sz);
        c.set(this.FRES);
        if (n >= bits) c.get(T[1]).i32(31).op(Op.i32_shr_u);
        else c.get(T[1]).i32(n - 1).op(Op.i32_shr_s).i32(1).op(Op.i32_and);
        c.set(this.FCIN).i32(0).set(this.FOF);
      }
      this.write(i.a!, this.FRES);
      this.setEagerFrom(sz);
      return false;
    }
    if (x === 0 || x === 1) {
      this.fallback(i);
      return false;
    }
    this.storeFlags();
    c.get(this.R[1]).i32(31).op(Op.i32_and).tee(T[4]);
    this.open("if", "shcl");
    this.read(i.a!);
    c.set(T[0]);
    if (x === 4 || x === 6) {
      c.get(T[0]).get(T[4]).op(Op.i32_shl);
      this.mask(sz);
      c.set(this.FRES);
      c.get(T[0]).i32(bits).get(T[4]).op(Op.i32_sub).op(Op.i32_shr_u).i32(1).op(Op.i32_and).i32(0).get(T[4]).i32(bits).op(Op.i32_le_u).op(Op.select).set(this.FCIN);
      this.signBit(sz, this.FRES);
      c.get(this.FCIN).op(Op.i32_xor).set(this.FOF);
    } else if (x === 5) {
      c.get(T[0]).get(T[4]).op(Op.i32_shr_u).set(this.FRES);
      c.get(T[0]).get(T[4]).i32(1).op(Op.i32_sub).op(Op.i32_shr_u).i32(1).op(Op.i32_and).set(this.FCIN);
      this.signBit(sz, T[0]);
      c.i32(0).get(T[4]).i32(1).op(Op.i32_eq).op(Op.select).set(this.FOF);
    } else {
      c.get(T[0]);
      if (sz === 1) c.op(Op.i32_extend8_s);
      else if (sz === 2) c.op(Op.i32_extend16_s);
      c.set(T[1]);
      c.get(T[1]).get(T[4]).i32(bits - 1).get(T[4]).i32(bits - 1).op(Op.i32_lt_u).op(Op.select).op(Op.i32_shr_s);
      this.mask(sz);
      c.set(this.FRES);
      c.get(T[1]).i32(31).op(Op.i32_shr_u);
      c.get(T[1]).get(T[4]).i32(1).op(Op.i32_sub).op(Op.i32_shr_s).i32(1).op(Op.i32_and);
      c.get(T[4]).i32(bits).op(Op.i32_ge_u).op(Op.select).set(this.FCIN).i32(0).set(this.FOF);
    }
    this.write(i.a!, this.FRES);
    this.setEagerFrom(sz);
    this.storeFlags();
    this.close();
    this.fs = { k: "mem" };
    void s;
    return false;
  }

  private bt(i: JInsn): boolean {
    const c = this.c, T = this.T, sz = i.sz, x = i.x!;
    if (i.a!.t !== "r") {
      this.fallback(i);
      return false;
    }
    this.read(i.b!);
    c.i32(sz * 8 - 1).op(Op.i32_and).set(T[1]);
    this.read(i.a!);
    c.set(T[0]);
    this.toWord();
    c.get(this.FW).i32(~1).op(Op.i32_and).get(T[0]).get(T[1]).op(Op.i32_shr_u).i32(1).op(Op.i32_and).op(Op.i32_or).set(this.FW);
    if (x === 0) return false;
    c.get(T[0]).i32(1).get(T[1]).op(Op.i32_shl);
    if (x === 1) c.op(Op.i32_or);
    else if (x === 2) c.i32(-1).op(Op.i32_xor).op(Op.i32_and);
    else c.op(Op.i32_xor);
    c.set(T[2]);
    this.write(i.a!, T[2]);
    return false;
  }

  // ---------- x87 ----------

  private loadTop(): void {
    this.c.i32(0).mem(Op.i32_load, this.sb + ST_FPU_TOP, 2).set(this.TOP);
  }
  /** Pushes the byte offset of st(i) relative to ST_FPU_ST, using TOP. */
  private stOff(i: number): void {
    const c = this.c;
    c.get(this.TOP);
    if (i) c.i32(i).op(Op.i32_add);
    c.i32(7).op(Op.i32_and).i32(3).op(Op.i32_shl);
  }
  private stGet(i: number): void {
    this.stOff(i);
    this.c.mem(Op.f64_load, this.sb + ST_FPU_ST, 3);
  }
  /** Stores the f64 in local `d` into st(i). */
  private stSet(i: number, d: number): void {
    this.stOff(i);
    this.c.get(d).mem(Op.f64_store, this.sb + ST_FPU_ST, 3);
  }
  private fpush(d: number): void {
    const c = this.c;
    c.get(this.TOP).i32(1).op(Op.i32_sub).i32(7).op(Op.i32_and).set(this.TOP);
    c.i32(0).get(this.TOP).mem(Op.i32_store, this.sb + ST_FPU_TOP, 2);
    this.stSet(0, d);
    c.get(this.TOP).i32(0).mem(Op.i32_store8, this.sb + ST_FPU_EMPTY);
  }
  private fpop(): void {
    const c = this.c;
    c.get(this.TOP).i32(1).mem(Op.i32_store8, this.sb + ST_FPU_EMPTY);
    c.get(this.TOP).i32(1).op(Op.i32_add).i32(7).op(Op.i32_and).set(this.TOP);
    c.i32(0).get(this.TOP).mem(Op.i32_store, this.sb + ST_FPU_TOP, 2);
  }
  /** Sets C0/C2/C3 from comparing locals a and b. */
  private fcompare(a: number, b: number): void {
    const c = this.c;
    c.i32(0);
    c.i32(0).mem(Op.i32_load, this.sb + ST_FPU_SW, 2).i32(~(C0 | C2 | C3)).op(Op.i32_and);
    c.i32(C0).i32(C3).i32(C0 | C2 | C3).i32(0).get(a).get(a).op(Op.f64_ne).get(b).get(b).op(Op.f64_ne).op(Op.i32_or).op(Op.select);
    c.get(a).get(b).op(Op.f64_eq).op(Op.select);
    c.get(a).get(b).op(Op.f64_lt).op(Op.select);
    c.op(Op.i32_or).mem(Op.i32_store, this.sb + ST_FPU_SW, 2);
  }
  private farith(x: number, a: number, b: number, dst: number): void {
    const c = this.c;
    switch (x) {
      case 0: c.get(a).get(b).op(Op.f64_add); break;
      case 1: c.get(a).get(b).op(Op.f64_mul); break;
      case 4: c.get(a).get(b).op(Op.f64_sub); break;
      case 5: c.get(b).get(a).op(Op.f64_sub); break;
      case 6: c.get(a).get(b).op(Op.f64_div); break;
      default: c.get(b).get(a).op(Op.f64_div); break;
    }
    c.set(this.D0);
    this.stSet(dst, this.D0);
  }
  private loadMemF(o: Opnd, int: boolean): void {
    const c = this.c;
    c.get(this.EA);
    if (int) {
      if (o.sz === 2) c.mem(Op.i32_load16_s).op(Op.f64_convert_i32_s);
      else if (o.sz === 4) c.mem(Op.i32_load).op(Op.f64_convert_i32_s);
      else c.mem(Op.i64_load).op(Op.f64_convert_i64_s);
    } else if (o.sz === 4) c.mem(Op.f32_load).op(Op.f64_promote_f32);
    else c.mem(Op.f64_load);
  }
  /** Rounds the f64 on the stack per the FPU control word. */
  private fround(): void {
    const c = this.c;
    c.set(this.D1);
    c.i32(0).mem(Op.i32_load, this.sb + ST_FPU_CW, 2).i32(10).op(Op.i32_shr_u).i32(3).op(Op.i32_and).set(this.T[5]);
    c.get(this.D1).op(Op.f64_nearest);
    c.get(this.D1).op(Op.f64_floor);
    c.get(this.D1).op(Op.f64_ceil);
    c.get(this.D1).op(Op.f64_trunc);
    c.get(this.T[5]).i32(2).op(Op.i32_eq).op(Op.select);
    c.get(this.T[5]).i32(1).op(Op.i32_eq).op(Op.select);
    c.get(this.T[5]).op(Op.i32_eqz).op(Op.select);
  }

  private fpu(i: JInsn): boolean | null {
    const c = this.c, x = i.x ?? 0;
    switch (i.op) {
      case "fld": case "fild": {
        this.prep(i.a);
        this.loadTop();
        this.loadMemF(i.a!, i.op === "fild");
        c.set(this.D0);
        this.fpush(this.D0);
        return false;
      }
      case "fld_st": {
        this.loadTop();
        this.stGet(i.y!);
        c.set(this.D0);
        this.fpush(this.D0);
        return false;
      }
      case "fldc": {
        this.loadTop();
        c.f64(FLDC[i.y!]).set(this.D0);
        this.fpush(this.D0);
        return false;
      }
      case "fst": {
        this.prep(i.a);
        this.loadTop();
        c.get(this.EA);
        this.stGet(0);
        if (i.sz === 4) c.op(Op.f32_demote_f64).mem(Op.f32_store);
        else c.mem(Op.f64_store);
        if (x) this.fpop();
        return false;
      }
      case "fst_st": {
        this.loadTop();
        this.stGet(0);
        c.set(this.D0);
        this.stSet(i.y!, this.D0);
        this.stOff(i.y!);
        c.i32(3).op(Op.i32_shr_u).i32(0).mem(Op.i32_store8, this.sb + ST_FPU_EMPTY);
        if (x) this.fpop();
        return false;
      }
      case "fist": {
        this.prep(i.a);
        this.loadTop();
        this.stGet(0);
        this.fround();
        c.set(this.D0);
        c.get(this.EA);
        if (i.sz === 8) {
          c.get(this.D0).f64(-9223372036854775808).op(Op.f64_ge).get(this.D0).f64(9223372036854775808).op(Op.f64_lt).op(Op.i32_and);
          c.if_(I64).get(this.D0).op(Op.i64_trunc_f64_s).else_().i64(-0x8000000000000000n).end();
          c.mem(Op.i64_store);
        } else {
          const lo = i.sz === 2 ? -32768 : -2147483648, hi = i.sz === 2 ? 32767 : 2147483647;
          c.get(this.D0).f64(lo).op(Op.f64_ge).get(this.D0).f64(hi).op(Op.f64_le).op(Op.i32_and);
          c.if_(I32).get(this.D0).op(Op.i32_trunc_f64_s).else_().i32(i.sz === 2 ? 0x8000 : -2147483648).end();
          this.store(i.sz);
        }
        if (x) this.fpop();
        return false;
      }
      case "farith": {
        this.prep(i.a);
        this.loadTop();
        this.loadMemF(i.a!, i.y === 1);
        c.set(this.D1);
        this.stGet(0);
        c.set(this.D0);
        if (x === 2 || x === 3) {
          this.fcompare(this.D0, this.D1);
          if (x === 3) this.fpop();
          return false;
        }
        this.farith(x, this.D0, this.D1, 0);
        return false;
      }
      case "farith_st": {
        this.loadTop();
        this.stGet(i.y!);
        c.set(this.D1);
        this.stGet(0);
        c.set(this.D0);
        if (x === 2 || x === 3) {
          this.fcompare(this.D0, this.D1);
          if (x === 3) this.fpop();
          return false;
        }
        this.farith(x, this.D0, this.D1, 0);
        return false;
      }
      case "farith_to": {
        const pop = i.c!.t === "i" && i.c!.v === 1;
        this.loadTop();
        this.stGet(i.y!);
        c.set(this.D0);
        this.stGet(0);
        c.set(this.D1);
        if (x === 2 || x === 3) {
          this.fcompare(this.D1, this.D0);
          if (x === 3) this.fpop();
        } else {
          const map = [0, 1, 0, 0, 5, 4, 7, 6];
          this.farith(map[x], this.D0, this.D1, i.y!);
        }
        if (pop) this.fpop();
        return false;
      }
      case "fcompp": case "fucompp": {
        this.loadTop();
        this.stGet(0);
        c.set(this.D0);
        this.stGet(1);
        c.set(this.D1);
        this.fcompare(this.D0, this.D1);
        this.fpop();
        this.fpop();
        return false;
      }
      case "fucom": {
        this.loadTop();
        this.stGet(0);
        c.set(this.D0);
        this.stGet(i.y!);
        c.set(this.D1);
        this.fcompare(this.D0, this.D1);
        if (x) this.fpop();
        return false;
      }
      case "ftst": {
        this.loadTop();
        this.stGet(0);
        c.set(this.D0);
        c.f64(0).set(this.D1);
        this.fcompare(this.D0, this.D1);
        return false;
      }
      case "fxch": {
        this.loadTop();
        this.stGet(0);
        c.set(this.D0);
        this.stGet(i.y!);
        c.set(this.D1);
        this.stSet(0, this.D1);
        this.stSet(i.y!, this.D0);
        return false;
      }
      case "fchs": case "fabs": case "fsqrt": {
        this.loadTop();
        this.stGet(0);
        c.op(i.op === "fchs" ? Op.f64_neg : i.op === "fabs" ? Op.f64_abs : Op.f64_sqrt).set(this.D0);
        this.stSet(0, this.D0);
        return false;
      }
      case "ffree": {
        this.loadTop();
        this.stOff(i.y!);
        c.i32(3).op(Op.i32_shr_u).i32(1).mem(Op.i32_store8, this.sb + ST_FPU_EMPTY);
        return false;
      }
      case "fnstsw": case "fnstsw_ax": {
        this.prep(i.a);
        c.i32(0).mem(Op.i32_load, this.sb + ST_FPU_SW, 2).i32(~0x3800).op(Op.i32_and);
        c.i32(0).mem(Op.i32_load, this.sb + ST_FPU_TOP, 2).i32(7).op(Op.i32_and).i32(11).op(Op.i32_shl).op(Op.i32_or).set(this.T[0]);
        this.write(i.op === "fnstsw" ? i.a! : { t: "r", r: 0, sz: 2 }, this.T[0]);
        return false;
      }
      case "fnstcw": {
        this.prep(i.a);
        c.i32(0).mem(Op.i32_load, this.sb + ST_FPU_CW, 2).set(this.T[0]);
        this.write(i.a!, this.T[0]);
        return false;
      }
      case "fldcw": {
        this.prep(i.a);
        c.i32(0);
        this.read(i.a!);
        c.mem(Op.i32_store, this.sb + ST_FPU_CW, 2);
        return false;
      }
    }
    return null;
  }

  // ---------- MMX ----------

  private mmx(i: JInsn): boolean | null {
    void i;
    return null;
  }
}
