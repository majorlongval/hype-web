import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Memory } from "../src/cpu/memory";
import { CPU } from "../src/cpu/cpu";

interface Vec {
  asm: string;
  code: string;
  regs: number[];
  flags: number;
  seed: number;
  outRegs: number[];
  outEip: number;
  outFlags: number;
  undef: number;
  mem: [number, number][];
  kind: string;
}

const CODE = 0x1000, DATA = 0x100000, DATA_SIZE = 0x10000, STACK = 0x200000, STACK_SIZE = 0x10000;
const ZF = 0x40;
const CHECKED_FLAGS = 0x1 | 0x4 | 0x10 | 0x40 | 0x80 | 0x400 | 0x800;

function xorshiftFill(seed: number, n: number): Uint8Array {
  const out = new Uint8Array(n);
  const dv = new DataView(out.buffer);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i += 4) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    dv.setUint32(i, x, true);
  }
  return out;
}

function diffRegion(u8: Uint8Array, base: number, before: Uint8Array, out: Map<number, number>): void {
  const a = new Uint32Array(u8.buffer, base, before.length / 4);
  const b = new Uint32Array(before.buffer);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      for (let k = 0; k < 4; k++) {
        const o = i * 4 + k;
        if (u8[base + o] !== before[o]) out.set(base + o, u8[base + o]);
      }
    }
  }
}

export function runVectors(file: string): { total: number; failures: string[]; byAsm: Map<string, number> } {
  const vecs: Vec[] = JSON.parse(readFileSync(file, "utf8"));
  const mem = new Memory(0x400000);
  const cpu = new CPU(mem);
  const failures: string[] = [];
  const byAsm = new Map<string, number>();
  for (const v of vecs) {
    const data = xorshiftFill(v.seed, DATA_SIZE);
    const stack = xorshiftFill((v.seed ^ 0x5a5a5a5a) >>> 0, STACK_SIZE);
    mem.u8.set(data, DATA);
    mem.u8.set(stack, STACK);
    mem.u8.fill(0x90, CODE, CODE + 0x100);
    const code = Buffer.from(v.code, "hex");
    mem.u8.set(code, CODE);
    for (let i = 0; i < 8; i++) cpu.r[i] = v.regs[i];
    cpu.setFlags(v.flags);
    cpu.eip = CODE;
    cpu.pages = [];
    cpu.fpu.reset();
    let err = "";
    try {
      cpu.step();
    } catch (e) {
      err = String(e);
    }
    const problems: string[] = [];
    if (err) problems.push(`threw ${err}`);
    const skipRegs = v.kind === "bsf" && (v.outFlags & ZF) !== 0;
    if (!skipRegs) {
      for (let i = 0; i < 8; i++) {
        if (cpu.r[i] >>> 0 !== v.outRegs[i] >>> 0) {
          problems.push(`r${i}=${(cpu.r[i] >>> 0).toString(16)} want ${(v.outRegs[i] >>> 0).toString(16)}`);
        }
      }
    }
    if (cpu.eip >>> 0 !== v.outEip >>> 0) problems.push(`eip=${cpu.eip.toString(16)} want ${v.outEip.toString(16)}`);
    const mask = CHECKED_FLAGS & ~v.undef;
    const got = cpu.getFlags() & mask, want = v.outFlags & mask;
    if (got !== want) problems.push(`flags=${got.toString(16)} want ${want.toString(16)} (xor ${(got ^ want).toString(16)})`);
    const changed = new Map<number, number>();
    diffRegion(mem.u8, DATA, data, changed);
    diffRegion(mem.u8, STACK, stack, changed);
    const expMem = new Map(v.mem.map(([a, b]) => [a, b] as [number, number]));
    for (const [a, b] of expMem) if (changed.get(a) !== b) { problems.push(`mem[${a.toString(16)}]=${changed.get(a)?.toString(16)} want ${b.toString(16)}`); break; }
    for (const [a, b] of changed) if (!expMem.has(a)) { problems.push(`unexpected mem[${a.toString(16)}]=${b.toString(16)}`); break; }
    if (problems.length) {
      const key = v.asm.split(" ")[0] + (v.kind ? ` (${v.kind})` : "");
      byAsm.set(key, (byAsm.get(key) ?? 0) + 1);
      if (failures.length < 60) failures.push(`${v.asm} [${v.code}] regs=${v.regs.map((x) => (x >>> 0).toString(16)).join(",")} fl=${v.flags.toString(16)}: ${problems.join("; ")}`);
    }
  }
  return { total: vecs.length, failures, byAsm };
}

describe("x86 interpreter vs unicorn", () => {
  it("matches reference vectors", () => {
    const { total, failures, byAsm } = runVectors("test/vectors/cpu-basic.json");
    if (failures.length) {
      console.log([...byAsm.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n}\t${k}`).join("\n"));
      console.log(failures.join("\n"));
    }
    expect(failures.length, `${failures.length} of ${total} failed`).toBe(0);
  }, 300000);
});
