import * as fs from "node:fs";
import * as path from "node:path";
import { bootGame, type Disc } from "../boot";
import type { FileSource } from "../win32/vfs";
import { hex } from "../win32/machine";

class NodeFile implements FileSource {
  private fd = -1;
  readonly size: number;
  constructor(private file: string) {
    this.size = fs.statSync(file).size;
  }
  read(offset: number, dst: Uint8Array, dstOff: number, len: number): number {
    if (this.fd < 0) this.fd = fs.openSync(this.file, "r");
    return fs.readSync(this.fd, dst, dstOff, Math.min(len, this.size - offset), offset);
  }
}

function dirDisc(root: string, label: string): Disc {
  const list: string[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else list.push(r);
    }
  };
  walk("");
  return {
    label,
    paths: () => list.map((p) => p.replaceAll("/", "\\")),
    open: (p) => new NodeFile(path.join(root, p.replaceAll("\\", "/"))),
  };
}

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

const root = process.argv[2];
if (!root) {
  console.error("usage: node-run <disc dir> [--label L] [--seconds S] [--frames N] [--trace api,api|all]");
  process.exit(2);
}
const seconds = Number(arg("seconds", "30"));
const maxFrames = Number(arg("frames", "0"));
const traceArg = arg("trace", "");

let skipped = 0;
const t0 = performance.now();
const now = () => performance.now() - t0 + skipped;
const host = { now, log: (msg: string) => console.log(`[${(now() / 1000).toFixed(3)}] ${msg}`) };

const { m } = bootGame({ disc: dirDisc(root, arg("label", "")), host });
if (traceArg) m.trace = traceArg === "all" ? "all" : new Set(traceArg.split(","));

const profFrom = Number(arg("prof", "0"));
let frames = 0;
const deadline = performance.now() + seconds * 1000;
try {
  while (performance.now() < deadline) {
    const r = m.run(50);
    if (r === "exit") break;
    if (r === "frame") {
      frames++;
      if (frames % 20 === 1) host.log(`frame ${frames} insns=${(m.cpu.icount / 1e6).toFixed(0)}M`);
      if (profFrom && frames === profFrom) m.cpu.prof = new Map();
      if (maxFrames && frames >= maxFrames) break;
    }
    if (r === "idle") skipped += Math.max(1, Math.min(10, m.nextWake() - now()));
  }
} catch (e) {
  console.log(`FATAL: ${(e as Error).message}`);
  console.log(`  eip=${hex(m.cpu.eip)} ${m.symbolize(m.cpu.eip)} thread=${m.cur?.label ?? "?"}`);
  for (const l of m.backtrace()) console.log(`  ${l}`);
}
for (const t of m.threads) {
  const w = t.wait ? ` wait[${t.wait.objs.map((o) => o.constructor.name + (o.name ? ":" + o.name : "")).join(",")}${t.wait.msgs !== undefined ? " msgs" : ""} deadline=${t.wait.deadline}]` : "";
  console.log(`thread ${t.label} ${t.state} prio=${t.priority}${w} frames=${t.frames.length}`);
  for (const l of m.backtrace(10, t)) console.log(`  ${l}`);
}
if (m.cpu.prof) {
  const byFn = new Map<string, number>();
  let total = 0;
  for (const [a, n] of m.cpu.prof) {
    const f = m.symbolize(a).replace(/\+0x[0-9a-f]+$/, "");
    byFn.set(f, (byFn.get(f) ?? 0) + n);
    total += n;
  }
  console.log(`\nprofile: ${(total / 1e6).toFixed(0)}M insns over ${frames - profFrom} frames`);
  for (const [f, n] of [...byFn].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  ${(100 * n / total).toFixed(1).padStart(5)}%  ${f}`);
  const blocks = [...m.cpu.prof].sort((a, b) => b[1] - a[1]).slice(0, 12);
  for (const [a, n] of blocks) console.log(`  blk ${hex(a)} ${(100 * n / total).toFixed(1)}% ${m.symbolize(a)}`);
}
const top = [...m.fns].filter((f) => f.calls > 0).sort((a, b) => b.calls - a.calls).slice(0, 25);
console.log(`\nframes=${frames} guest-time=${(now() / 1000).toFixed(1)}s exited=${m.exited} code=${m.exitCode}`);
console.log(top.map((f) => `${f.mod}!${f.name}=${f.calls}`).join(" "));
