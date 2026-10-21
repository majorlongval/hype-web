import { describe, it, expect } from "vitest";
import { runVectors } from "./cpu-diff.test";
import { runFpuVectors } from "./fpu-diff.test";
import { Jit } from "../src/cpu/jit/jit";
import type { CPU } from "../src/cpu/cpu";

describe("x86 JIT vs unicorn", () => {
  it("matches reference vectors", () => {
    let jit: Jit | null = null;
    const step = (cpu: CPU) => {
      if (!jit || jit["cpu"] !== cpu) jit = new Jit(cpu);
      jit.invalidate(0, 0x10000);
      const fn = jit.compileRegion(jit.singleInsn(cpu.eip));
      jit.exec({ fn, idx: 0 }, 1000);
      if (cpu.jitOff) {
        cpu.jitOff = 0;
        cpu.step();
      }
    };
    const { total, failures, byAsm } = runVectors("test/vectors/cpu-basic.json", step);
    if (failures.length) {
      console.log([...byAsm.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n}\t${k}`).join("\n"));
      console.log(failures.slice(0, 40).join("\n"));
    }
    expect(failures.length, `${failures.length} of ${total} failed`).toBe(0);
  }, 600000);
});

describe("x87 and MMX JIT vs unicorn", () => {
  it("matches reference vectors", () => {
    let jit: Jit | null = null;
    const runCode = (cpu: CPU, end: number) => {
      if (!jit || jit["cpu"] !== cpu) jit = new Jit(cpu);
      jit.invalidate(0, 0x10000);
      const fn = jit.compileRegion(jit.linearRegion(cpu.eip, end));
      jit.exec({ fn, idx: 0 }, 1000);
      for (let i = 0; i < 100 && cpu.eip !== end; i++) cpu.step();
    };
    const { failures, byOp, total } = runFpuVectors(runCode);
    if (failures.length) {
      console.log([...byOp.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n}\t${k}`).join("\n"));
      console.log(failures.slice(0, 40).join("\n"));
    }
    expect(failures.length, `${failures.length} of ${total} failed`).toBe(0);
  }, 600000);
});
