import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Memory } from "../src/cpu/memory";
import { CPU } from "../src/cpu/cpu";

interface Vec { asm: string; code: string; input: string; out: string; slots: [string, number, number][]; eax: number }

const CODE = 0x1000, IN = 0x101000, OUT = 0x102000, STACK = 0x208000;

function ordered64(dv: DataView, off: number): bigint {
  const v = dv.getBigInt64(off, true);
  return v < 0n ? -(v & 0x7fffffffffffffffn) : v;
}
function ordered32(dv: DataView, off: number): number {
  const v = dv.getInt32(off, true);
  return v < 0 ? -(v & 0x7fffffff) : v;
}

describe("x87 and MMX vs unicorn", () => {
  it("matches reference vectors", () => {
    const vecs: Vec[] = JSON.parse(readFileSync("test/vectors/fpu-basic.json", "utf8"));
    const mem = new Memory(0x400000);
    const cpu = new CPU(mem);
    const failures: string[] = [];
    const byOp = new Map<string, number>();
    for (const v of vecs) {
      mem.u8.fill(0, 0x100000, 0x110000);
      mem.u8.set(Buffer.from(v.input, "hex"), IN);
      const code = Buffer.from(v.code, "hex");
      mem.u8.fill(0x90, CODE, CODE + 0x200);
      mem.u8.set(code, CODE);
      cpu.r.fill(0);
      cpu.r[6] = IN;
      cpu.r[7] = OUT;
      cpu.r[4] = STACK;
      cpu.setFlags(0x202);
      cpu.fpu.reset();
      cpu.pages = [];
      cpu.eip = CODE;
      const end = CODE + code.length;
      let err = "";
      try {
        for (let i = 0; i < 100 && cpu.eip !== end; i++) cpu.step();
      } catch (e) {
        err = String(e);
      }
      const want = new DataView(new Uint8Array(Buffer.from(v.out, "hex")).buffer);
      const got = new DataView(mem.buf, OUT, 64);
      const probs: string[] = [];
      if (err) probs.push(err);
      for (const [type, off, tol] of v.slots) {
        if (type === "f64") {
          const a = got.getFloat64(off, true), b = want.getFloat64(off, true);
          if (Number.isNaN(a) && Number.isNaN(b)) continue;
          const d = ordered64(got, off) - ordered64(want, off);
          if ((d < 0n ? -d : d) > BigInt(tol)) probs.push(`f64@${off} ${a} want ${b}`);
        } else if (type === "f32") {
          const a = got.getFloat32(off, true), b = want.getFloat32(off, true);
          if (Number.isNaN(a) && Number.isNaN(b)) continue;
          if (Math.abs(ordered32(got, off) - ordered32(want, off)) > tol) probs.push(`f32@${off} ${a} want ${b}`);
        } else if (type === "sw") {
          const a = got.getUint16(off, true) & 0x4500, b = want.getUint16(off, true) & 0x4500;
          if (a !== b) probs.push(`sw@${off} ${a.toString(16)} want ${b.toString(16)}`);
        } else {
          for (let i = 0; i < tol; i++) {
            if (got.getUint8(off + i) !== want.getUint8(off + i)) {
              probs.push(`bytes@${off} ${Buffer.from(mem.u8.slice(OUT + off, OUT + off + tol)).toString("hex")} want ${Buffer.from(new Uint8Array(want.buffer, off, tol)).toString("hex")}`);
              break;
            }
          }
        }
      }
      if (probs.length) {
        const key = v.asm.split("; ").find((l) => !l.startsWith("fld ") && !l.startsWith("movq mm") && !l.startsWith("mov ")) ?? v.asm;
        byOp.set(key.split(" ")[0], (byOp.get(key.split(" ")[0]) ?? 0) + 1);
        if (failures.length < 50) failures.push(`${v.asm}\n   in=${v.input.slice(0, 80)} :: ${probs.join("; ")}`);
      }
    }
    if (failures.length) {
      console.log([...byOp.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n}\t${k}`).join("\n"));
      console.log(failures.join("\n"));
    }
    expect(failures.length, `${failures.length} of ${vecs.length} failed`).toBe(0);
  }, 300000);
});
