import * as fs from "node:fs";
import * as path from "node:path";
import { bootGame, type Disc } from "../boot";
import { IsoFileSource, readIso } from "../media/iso9660";
import type { FileSource } from "../win32/vfs";
import { hex } from "../win32/machine";
import { glide, LFB_UNTOUCHED16, LFB_UNTOUCHED32, type GlideBackend } from "../win32/glide3x";
import { mm } from "../win32/winmm";
import { injectKey } from "../win32/user32";
import { diKey } from "../win32/dinput";
import { KEYMAP } from "../win32/keys";

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

function isoDisc(file: string, label: string): Disc {
  const image = new NodeFile(file);
  const iso = readIso(image);
  const byUpper = new Map(iso.files.map((f) => [f.path.toUpperCase(), f]));
  return {
    label: label || iso.label,
    paths: () => iso.files.map((f) => f.path),
    open: (p) => new IsoFileSource(image, byUpper.get(p.toUpperCase())!),
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

const baseDisc = root.toLowerCase().endsWith(".iso") ? isoDisc(root, arg("label", "")) : dirDisc(root, arg("label", ""));
const { m } = bootGame({ disc: baseDisc, host });
if (process.argv.includes("--nojit")) m.cpu.jit = null;
if (process.argv.includes("--trace-files")) {
  const lookup = m.vfs.lookup.bind(m.vfs);
  m.vfs.lookup = (p: string) => {
    const n = lookup(p);
    host.log(`file ${p}${n ? "" : " (missing)"}`);
    return n;
  };
}
if (traceArg) m.trace = traceArg === "all" ? "all" : new Set(traceArg.split(","));

const profFrom = Number(arg("prof", "0"));
const wavPath = arg("wav", "");
const pcm: Uint8Array[] = [];
let wavFmt = { rate: 22050, ch: 2, bits: 16 };
if (wavPath) {
  mm(m).sink = {
    open: (_id, rate, ch, bits) => { wavFmt = { rate, ch, bits }; },
    write: (_id, data) => { pcm.push(data.slice()); },
    close: () => {},
    reset: () => {},
  };
}
const script: [number, string, number][] = JSON.parse(arg("keys", "[]"));
const pending: [number, string, boolean][] = [];
for (const [t, code, hold] of script) pending.push([t * 1000, code, true], [t * 1000 + (hold ?? 120), code, false]);
pending.sort((a, b) => a[0] - b[0]);
const pump = () => {
  while (pending.length && pending[0][0] <= now()) {
    const [, code, down] = pending.shift()!;
    const k = KEYMAP[code];
    if (k) {
      injectKey(m, k[0], down);
      diKey(m, k[1], down);
      if (down) host.log(`key ${code}`);
    }
  }
};
const DEMO_PLAY_VIDEO = 0x4ebbeb, DEMO_VIDEO_ACTIVE = 0x6df3bc, DEMO_IAT_SLEEP = 0x590084;
const videoArg = arg("video", "");
let videoAt = videoArg ? Number(arg("video-at", "6")) * 1000 : Infinity;
const playVideo = () => {
  const prologue = [0x55, 0x8b, 0xec, 0x8b, 0x45, 0x0c];
  if (prologue.some((b, i) => m.mem.u8[DEMO_PLAY_VIDEO + i] !== b)) throw new Error("--video only knows the demo's Glide exe");
  const name = path.basename(videoArg);
  m.vfs.addFile(`D:\\Videos\\${name}`, new NodeFile(videoArg));
  const code = m.sysAlloc(48);
  const call = code + 9;
  const bytes = [
    0x60, 0x9c, 0x6a, Number(arg("video-mode", "2")), 0x68, 0, 0, 0, 0, 0xe8, 0, 0, 0, 0, 0x83, 0xc4, 0x08,
    0x83, 0x3d, 0, 0, 0, 0, 0x00, 0x74, 0x0a, 0x6a, 0x0a, 0xff, 0x15, 0, 0, 0, 0, 0xeb, 0xed,
    0x9d, 0x61, 0xc3,
  ];
  m.mem.u8.set(bytes, code);
  m.mem.dv.setUint32(code + 5, m.sysString(name), true);
  m.mem.dv.setInt32(call + 1, DEMO_PLAY_VIDEO - (call + 5), true);
  m.mem.dv.setUint32(code + 19, DEMO_VIDEO_ACTIVE, true);
  m.mem.dv.setUint32(code + 30, DEMO_IAT_SLEEP, true);
  const t = m.cur!;
  t.ctx.save(m.cpu);
  t.ctx.regs[4] -= 4;
  m.mem.dv.setUint32(t.ctx.regs[4], t.ctx.eip, true);
  t.ctx.eip = code;
  t.ctx.load(m.cpu);
  host.log(`video: injected play(${name}) into thread ${t.label} after a buffer swap`);
};

class ShotBackend implements GlideBackend {
  w = 640;
  h = 480;
  rgb = new Uint8Array(640 * 480 * 3);
  open(width: number, height: number): void {
    this.w = width;
    this.h = height;
    this.rgb = new Uint8Array(width * height * 3);
  }
  lfbWrite(_b: number, x: number, y: number, w: number, h: number, px: Uint16Array | Uint32Array, fmt: number): void {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const v = px[j * w + i];
        const sx = x + i, sy = y + j;
        if (sx >= this.w || sy >= this.h || v === (px instanceof Uint32Array ? LFB_UNTOUCHED32 : LFB_UNTOUCHED16)) continue;
        const o = (sy * this.w + sx) * 3;
        if (fmt === 4 || fmt === 5) this.rgb.set([(v >> 16) & 255, (v >> 8) & 255, v & 255], o);
        else if (fmt === 0) this.rgb.set([((v >> 11) & 31) * 255 / 31, ((v >> 5) & 63) * 255 / 63, (v & 31) * 255 / 31], o);
        else this.rgb.set([((v >> 10) & 31) * 255 / 31, ((v >> 5) & 31) * 255 / 31, (v & 31) * 255 / 31], o);
      }
    }
  }
  close(): void {}
  clear(): void {}
  swap(): void {}
  draw(): void {}
  texWritten(): void {}
  paletteChanged(): void {}
  lfbRead(_b: number, w: number, h: number): Uint16Array {
    return new Uint16Array(w * h);
  }
  save(file: string): void {
    fs.writeFileSync(file, Buffer.concat([Buffer.from(`P6 ${this.w} ${this.h} 255\n`), this.rgb]));
  }
}
const shots = arg("shots", "").split(",").filter(Boolean).map((t) => Number(t) * 1000);
const shotDir = arg("shot-dir", "/tmp");
const shooter = shots.length ? new ShotBackend() : null;
if (shooter) glide(m).backend = shooter;

let frames = 0;
const deadline = performance.now() + seconds * 1000;
try {
  while (performance.now() < deadline) {
    pump();
    const r = m.run(20);
    if (r === "exit") break;
    if (r === "frame") {
      frames++;
      while (shooter && shots.length && now() >= shots[0]) {
        const file = path.join(shotDir, `shot-${(shots.shift()! / 1000).toFixed(1)}.ppm`);
        shooter.save(file);
        host.log(`saved ${file}`);
      }
      if (now() >= videoAt) {
        videoAt = Infinity;
        playVideo();
      }
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
if (wavPath) {
  const n = pcm.reduce((a, b) => a + b.length, 0);
  const out = Buffer.alloc(44 + n);
  out.write("RIFF", 0); out.writeUInt32LE(36 + n, 4); out.write("WAVEfmt ", 8); out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); out.writeUInt16LE(wavFmt.ch, 22); out.writeUInt32LE(wavFmt.rate, 24);
  out.writeUInt32LE(wavFmt.rate * wavFmt.ch * wavFmt.bits / 8, 28); out.writeUInt16LE(wavFmt.ch * wavFmt.bits / 8, 32);
  out.writeUInt16LE(wavFmt.bits, 34); out.write("data", 36); out.writeUInt32LE(n, 40);
  let o = 44;
  for (const b of pcm) { out.set(b, o); o += b.length; }
  fs.writeFileSync(wavPath, out);
  console.log(`wrote ${wavPath}: ${(n / (wavFmt.rate * wavFmt.ch * wavFmt.bits / 8)).toFixed(1)}s of audio`);
}
if (m.cpu.jit) console.log(`jit: ${JSON.stringify(m.cpu.jit.stats)}`);
console.log(`\nframes=${frames} guest-time=${(now() / 1000).toFixed(1)}s exited=${m.exited} code=${m.exitCode}`);
console.log(top.map((f) => `${f.mod}!${f.name}=${f.calls}`).join(" "));
