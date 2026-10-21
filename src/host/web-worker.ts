import { bootGame, readInstallPlan, type Disc } from "../boot";
import type { FileSource, PersistStore } from "../win32/vfs";
import { glide } from "../win32/glide3x";
import { mm, type AudioSink } from "../win32/winmm";
import { injectKey } from "../win32/user32";
import { di, diKey } from "../win32/dinput";
import { KEYMAP } from "../win32/keys";
import type { Machine } from "../win32/machine";
import { WebGLGlide } from "./webgl-glide";
import type { DiscSpec, FromWorker, ToWorker } from "./protocol";

const post = (msg: FromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);
const log = (msg: string) => post({ t: "log", msg });

const BLOCK = 1 << 18;
const MAX_BLOCKS = 96;
const blocks = new Map<string, Uint8Array>();

abstract class BlockFile implements FileSource {
  private static nextId = 0;
  private id = BlockFile.nextId++;
  constructor(readonly size: number) {}
  protected abstract fetch(start: number, end: number): Uint8Array;
  read(offset: number, dst: Uint8Array, dstOff: number, len: number): number {
    const n = Math.max(0, Math.min(len, this.size - offset));
    let done = 0;
    while (done < n) {
      const pos = offset + done;
      const b = Math.floor(pos / BLOCK);
      const key = `${this.id}:${b}`;
      let data = blocks.get(key);
      if (data) blocks.delete(key);
      else data = this.fetch(b * BLOCK, Math.min(this.size, (b + 1) * BLOCK));
      blocks.set(key, data);
      if (blocks.size > MAX_BLOCKS) blocks.delete(blocks.keys().next().value!);
      const inner = pos - b * BLOCK;
      const k = Math.min(n - done, data.length - inner);
      dst.set(data.subarray(inner, inner + k), dstOff + done);
      done += k;
    }
    return n;
  }
}

class LocalFile extends BlockFile {
  private static reader = new FileReaderSync();
  constructor(private file: File) {
    super(file.size);
  }
  protected fetch(start: number, end: number): Uint8Array {
    return new Uint8Array(LocalFile.reader.readAsArrayBuffer(this.file.slice(start, end)));
  }
}

class HttpFile extends BlockFile {
  constructor(private url: string, size: number) {
    super(size);
  }
  protected fetch(start: number, end: number): Uint8Array {
    const x = new XMLHttpRequest();
    x.open("GET", this.url, false);
    x.responseType = "arraybuffer";
    x.setRequestHeader("Range", `bytes=${start}-${end - 1}`);
    x.send();
    if (x.status !== 206 && x.status !== 200) throw new Error(`${this.url}: HTTP ${x.status}`);
    const buf = new Uint8Array(x.response as ArrayBuffer);
    return x.status === 200 ? buf.slice(start, end) : buf;
  }
}

async function openDisc(spec: DiscSpec): Promise<Disc> {
  if (spec.kind === "files") {
    const map = new Map(spec.files.map(([p, f]) => [p.toUpperCase(), [p, f] as const]));
    return {
      label: spec.label,
      paths: () => spec.files.map(([p]) => p),
      open: (p) => new LocalFile(map.get(p.toUpperCase())![1]),
    };
  }
  const manifest = (await (await fetch(`${spec.base}manifest.json`)).json()) as [string, number][];
  const sizes = new Map(manifest.map(([p, s]) => [p.toUpperCase(), s]));
  return {
    label: spec.label,
    paths: () => manifest.map(([p]) => p),
    open: (p) => new HttpFile(`${spec.base}${p.replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/")}`, sizes.get(p.toUpperCase()) ?? 0),
  };
}

async function openSaves(label: string): Promise<[Map<string, Uint8Array>, PersistStore | undefined]> {
  const saved = new Map<string, Uint8Array>();
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(`saves-${label.replace(/[^A-Za-z0-9]+/g, "_")}`, { create: true });
    for await (const [name, h] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (h.kind !== "file") continue;
      const f = await (h as FileSystemFileHandle).getFile();
      saved.set(decodeURIComponent(name), new Uint8Array(await f.arrayBuffer()));
    }
    const store: PersistStore = {
      save(path, data) {
        const copy = data.slice();
        (async () => {
          const fh = await dir.getFileHandle(encodeURIComponent(path), { create: true });
          const w = await fh.createWritable();
          await w.write(copy);
          await w.close();
        })().catch((e) => log(`save ${path} failed: ${e}`));
      },
      remove(path) {
        dir.removeEntry(encodeURIComponent(path)).catch(() => {});
      },
    };
    if (saved.size) log(`restored ${saved.size} saved file(s)`);
    return [saved, store];
  } catch (e) {
    log(`persistent storage unavailable: ${e}`);
    return [saved, undefined];
  }
}

class WorkerAudio implements AudioSink {
  private fmt = new Map<number, { bits: number; channels: number }>();
  open(id: number, rate: number, channels: number, bits: number): void {
    this.fmt.set(id, { bits, channels });
    post({ t: "audio-open", id, rate, channels });
  }
  write(id: number, pcm: Uint8Array): void {
    const f = this.fmt.get(id);
    if (!f) return;
    let out: Float32Array;
    if (f.bits === 16) {
      const s = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 1);
      out = new Float32Array(s.length);
      for (let i = 0; i < s.length; i++) out[i] = s[i] / 32768;
    } else {
      out = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) out[i] = (pcm[i] - 128) / 128;
    }
    post({ t: "audio-data", id, data: out }, [out.buffer]);
  }
  close(id: number): void {
    this.fmt.delete(id);
    post({ t: "audio-close", id });
  }
  reset(id: number): void {
    post({ t: "audio-reset", id });
  }
}

let m: Machine | null = null;
let gfx: WebGLGlide | null = null;
let paused = false;
let frames = 0;
let lastStats = performance.now();
let lastInsns = 0;
let lastDraws = 0;
let scheduled = false;
const channel = new MessageChannel();
channel.port1.onmessage = () => tick();

function schedule(delay: number): void {
  if (scheduled) return;
  scheduled = true;
  if (delay <= 0) channel.port2.postMessage(0);
  else setTimeout(() => tick(), delay);
}

function tick(): void {
  scheduled = false;
  if (!m || paused) return;
  const start = performance.now();
  let r: ReturnType<Machine["run"]> = "slice";
  try {
    while (performance.now() - start < 16) {
      r = m.run(16 - (performance.now() - start));
      if (r === "frame") frames++;
      if (r !== "slice") break;
    }
  } catch (e) {
    const err = e as Error;
    post({ t: "error", msg: `${err.message}\n${m.backtrace().join("\n")}` });
    m = null;
    return;
  }
  const now = performance.now();
  if (now - lastStats >= 1000) {
    const dt = (now - lastStats) / 1000;
    post({ t: "stats", fps: frames / dt, mips: (m.cpu.icount - lastInsns) / dt / 1e6, draws: (gfx!.drawCalls - lastDraws) / Math.max(1, frames) });
    frames = 0;
    lastInsns = m.cpu.icount;
    lastDraws = gfx!.drawCalls;
    lastStats = now;
  }
  if (r === "exit") {
    post({ t: "exit", code: m.exitCode });
    m = null;
    return;
  }
  if (r === "idle") schedule(Math.max(1, Math.min(10, m.nextWake() - m.now())));
  else schedule(0);
}

async function start(msg: Extract<ToWorker, { t: "start" }>): Promise<void> {
  post({ t: "status", msg: "Reading disc…" });
  const disc = await openDisc(msg.disc);
  const [saved, persist] = await openSaves(msg.disc.label || readInstallPlan(disc).volumeName);
  const t0 = performance.now();
  const host = { now: () => performance.now() - t0, log };
  const booted = bootGame({ disc, host, language: msg.language, saved, persist });
  m = booted.m;
  const g = glide(m);
  msg.canvas.width = msg.width;
  msg.canvas.height = msg.height;
  gfx = new WebGLGlide(msg.canvas, g);
  g.backend = gfx;
  mm(m).sink = new WorkerAudio();
  post({ t: "status", msg: `Running ${booted.plan.appName}` });
  schedule(0);
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  switch (msg.t) {
    case "start":
      start(msg).catch((err: Error) => post({ t: "error", msg: err.stack ?? String(err) }));
      break;
    case "key": {
      const k = KEYMAP[msg.code];
      if (!m || !k) return;
      injectKey(m, k[0], msg.down);
      diKey(m, k[1], msg.down);
      break;
    }
    case "resize":
      gfx?.resize(msg.width, msg.height);
      break;
    case "pad": {
      if (!m) return;
      const p = di(m).pad;
      p.connected = msg.connected;
      for (let i = 0; i < 4; i++) p.axes[i] = msg.axes[i] ?? 0;
      for (let i = 0; i < 16; i++) p.buttons[i] = (msg.buttons >> i) & 1 ? 0x80 : 0;
      break;
    }
    case "pause":
      paused = msg.paused;
      if (!paused) schedule(0);
      break;
  }
};
