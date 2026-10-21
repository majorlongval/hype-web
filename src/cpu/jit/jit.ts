import type { CPU } from "../cpu";
import { decodeBlock, type Block, type JitEntry } from "../decode";
import { decode, type JInsn } from "./x86";
import { RegionCompiler, type RBlock, type Region } from "./codegen";

export const HOT = 40;
const MAX_INSNS = 800;
const MAX_BLOCKS = 96;
const MAX_BLOCK_INSNS = 200;

export class Jit {
  readonly budget = new WebAssembly.Global({ value: "i32", mutable: true }, 0);
  readonly resume = new WebAssembly.Global({ value: "i32", mutable: true }, 0);
  readonly force = new WebAssembly.Global({ value: "i32", mutable: true }, 0);
  private readonly imports: WebAssembly.Imports;
  private readonly single = new Map<number, Block>();
  private readonly pages: number;
  readonly stats = { regions: 0, blocks: 0, insns: 0, fallbacks: 0, compileMs: 0, failures: 0, traps: 0 };
  failed = new Set<number>();
  trace: ((msg: string) => void) | null = null;

  constructor(private cpu: CPU) {
    this.pages = cpu.mem.wasm.buffer.byteLength / 65536;
    this.imports = {
      e: {
        m: cpu.mem.wasm,
        budget: this.budget,
        resume: this.resume,
        force: this.force,
        interp: (a: number) => this.interp1(a >>> 0),
        cond: (cc: number) => (cpu.cond(cc) ? 1 : 0),
        flags: () => cpu.getFlags(),
      },
    };
  }

  private interp1(addr: number): number {
    const cpu = this.cpu;
    let b = this.single.get(addr);
    if (!b) {
      b = decodeBlock(cpu, addr, 1);
      this.single.set(addr, b);
    }
    cpu.eip = b.end;
    try {
      b.insns[0].exec(cpu);
    } catch (e) {
      cpu.eip = addr;
      throw e;
    }
    return cpu.eip | 0;
  }

  private isCode(pc: number): boolean {
    const c = this.cpu;
    return pc >= 0x1000 && pc < c.mem.guestSize - 16 && ((pc - c.hleBase) >>> 0) >= c.hleSize;
  }

  private decodeAt(pc: number): JInsn {
    const i = decode(this.cpu.u8, pc);
    if (i.op === "interp") {
      const b = decodeBlock(this.cpu, pc, 1);
      i.next = b.end;
      if (b.insns[0].flow) i.flow = true;
    }
    return i;
  }

  invalidate(start: number, len: number): void {
    for (const a of this.single.keys()) if (a >= start - 16 && a < start + len) this.single.delete(a);
    for (const a of this.failed) if (a >= start - 16 && a < start + len) this.failed.delete(a);
  }

  /** Compiles a region without registering it (tests). */
  compileRegion(region: Region): (pc: number) => number {
    const bytes = RegionCompiler.module([new RegionCompiler(region, this.cpu.mem.stateBase)], this.pages);
    const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes as BufferSource), this.imports);
    return inst.exports.r0 as (pc: number) => number;
  }

  singleInsn(pc: number): Region {
    const i = this.decodeAt(pc);
    return { entry: pc, blocks: [{ start: pc, end: i.next, insns: [i] }] };
  }

  /** One straight-line block covering [start, end) (tests). */
  linearRegion(start: number, end: number): Region {
    const insns: JInsn[] = [];
    for (let pc = start; pc < end; ) {
      const i = this.decodeAt(pc);
      insns.push(i);
      pc = i.next;
    }
    return { entry: start, blocks: [{ start, end, insns }] };
  }

  buildRegion(entry: number): Region {
    const insns = new Map<number, JInsn>();
    const leaders: number[] = [entry];
    const isLeader = new Set<number>([entry]);
    const lead = (a: number) => {
      if (!isLeader.has(a) && this.isCode(a)) {
        isLeader.add(a);
        leaders.push(a);
        work.push(a);
      }
    };
    const work = [entry];
    let total = 0;
    while (work.length && total < MAX_INSNS && leaders.length < MAX_BLOCKS) {
      let pc = work.shift()!;
      while (!insns.has(pc) && total < MAX_INSNS && this.isCode(pc)) {
        const i = this.decodeAt(pc);
        insns.set(pc, i);
        total++;
        if (i.flow) {
          if (i.op === "jcc" || i.op.startsWith("loop") || i.op === "jecxz") {
            lead(i.target!);
            lead(i.next);
          } else if (i.op === "jmp") lead(i.target!);
          break;
        }
        pc = i.next;
        if (isLeader.has(pc)) break;
      }
    }
    const blocks: RBlock[] = [];
    for (const start of leaders.slice(0, MAX_BLOCKS)) {
      if (!insns.has(start)) continue;
      const b: RBlock = { start, end: start, insns: [] };
      let pc = start;
      for (;;) {
        const i = insns.get(pc);
        if (!i) break;
        b.insns.push(i);
        pc = i.next;
        if (i.flow || b.insns.length >= MAX_BLOCK_INSNS || isLeader.has(pc)) break;
      }
      b.end = pc;
      blocks.push(b);
    }
    blocks.sort((a, b) => a.start - b.start);
    return { entry, blocks };
  }

  compile(entry: number): boolean {
    if (this.failed.has(entry)) return false;
    const t0 = performance.now();
    const region = this.buildRegion(entry);
    if (!region.blocks.length) {
      this.failed.add(entry);
      return false;
    }
    let fn: (pc: number) => number;
    try {
      const bytes = RegionCompiler.module([new RegionCompiler(region, this.cpu.mem.stateBase)], this.pages);
      const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes as BufferSource), this.imports);
      fn = inst.exports.r0 as (pc: number) => number;
    } catch (e) {
      this.failed.add(entry);
      this.stats.failures++;
      this.trace?.(`jit: compile failed at ${entry.toString(16)}: ${(e as Error).message}`);
      return false;
    }
    region.blocks.forEach((b, idx) => {
      const blk = this.cpu.lookup(b.start);
      if (!blk.jit) blk.jit = { fn, idx };
    });
    this.stats.regions++;
    this.stats.blocks += region.blocks.length;
    for (const b of region.blocks) {
      this.stats.insns += b.insns.length;
      for (const i of b.insns) if (i.op === "interp" || i.op.startsWith("m") && !i.op.startsWith("mov") && i.op !== "mul") this.stats.fallbacks++;
    }
    this.stats.compileMs += performance.now() - t0;
    return true;
  }

  /** Runs compiled code from `e`; returns the number of instructions it retired. */
  exec(e: JitEntry, budget: number): number {
    const cpu = this.cpu;
    this.budget.value = budget;
    this.resume.value = cpu.eip;
    this.force.value = 0;
    try {
      cpu.eip = e.fn(e.idx) >>> 0;
    } catch (err) {
      cpu.eip = this.resume.value >>> 0;
      if (err instanceof WebAssembly.RuntimeError) {
        this.stats.traps++;
        cpu.jitOff = 256;
        return Math.max(1, budget - (this.budget.value as number));
      }
      throw err;
    }
    if (this.force.value) cpu.jitOff = 1;
    return Math.max(1, budget - (this.budget.value as number));
  }
}
