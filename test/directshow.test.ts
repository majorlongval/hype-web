import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, it } from "vitest";
import { Args, HLE_BASE, Machine } from "../src/win32/machine";
import { registerDirectShow, videoPlayback } from "../src/win32/directshow";
import { writeGuid } from "../src/win32/com";
import { DRIVE_FIXED, MemSource, VFS } from "../src/win32/vfs";
import { glide, NullBackend } from "../src/win32/glide3x";
import { mm } from "../src/win32/winmm";
import type { HleGen } from "../src/win32/thread";

let avi: Uint8Array, reference: Uint8Array, audio: Uint8Array;
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "hype-stream-")), file = join(dir, "movie.avi");
  const run = (args: string[]) => execFileSync("ffmpeg", ["-v", "error", ...args], { maxBuffer: 1 << 24 });
  run(["-f", "lavfi", "-i", "testsrc=size=16x8:rate=4", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000",
    "-t", "1", "-c:v", "rawvideo", "-pix_fmt", "bgr24", "-c:a", "pcm_s16le", "-ac", "1", file]);
  avi = readFileSync(file);
  reference = run(["-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  audio = run(["-i", file, "-f", "s16le", "-"]);
});

it("plays multimedia samples with RGB pixels, timed PCM, end-of-stream, and a second movie", () => {
  const vfs = new VFS();
  vfs.addDrive({ letter: "C", type: DRIVE_FIXED, label: "T", serial: 1, fs: "FAT32" });
  vfs.cwd = "C:\\"; vfs.addFile("C:\\movie.avi", new MemSource(avi));
  let clock = 0;
  const m = new Machine(vfs, { now: () => clock, log: () => {} });
  registerDirectShow(m);
  const scratch = m.sysAlloc(128), out = m.sysAlloc(256), guid = m.sysAlloc(16);
  const u32 = (p: number) => m.mem.dv.getUint32(p, true);
  const invoke = (addr: number, args: number[]): number => {
    args.forEach((n, i) => m.mem.dv.setUint32(scratch + i * 4, n >>> 0, true));
    const fn = m.fns[(addr - HLE_BASE) / 16];
    expect(fn.pop).toBe(args.length * 4);
    const result = fn.impl!(m, new Args(m, scratch));
    if (typeof result !== "object") return (result ?? 0) as number;
    const gen = result as HleGen;
    let r = gen.next();
    while (!r.done) {
      expect(r.value.t).toBe("wait");
      if (r.value.t === "wait") clock = r.value.deadline;
      r = gen.next(0x102);
    }
    return (r.value ?? 0) as number;
  };
  const method = (obj: number, index: number, ...args: number[]) => invoke(u32(u32(obj) + index * 4), [obj, ...args]);
  const create = (id: string) => {
    writeGuid(m, guid, id);
    expect(invoke(m.thunk("ole32.dll", "CoCreateInstance"), [guid, 0, 1, guid, out])).toBe(0);
    return u32(out);
  };
  let pixels = new Uint32Array();
  class Capture extends NullBackend {
    override lfbWrite(_b?: number, _x?: number, _y?: number, _w?: number, _h?: number, px?: Uint16Array | Uint32Array): void { pixels = new Uint32Array(px!); }
  }
  glide(m).backend = new Capture();
  const chunks: Uint8Array[] = [];
  let opened = 0, closed = 0, reset = 0;
  mm(m).sink = {
    open: (_id, rate, channels, bits) => { expect([rate, channels, bits]).toEqual([8000, 1, 16]); opened++; },
    write: (_id, data) => chunks.push(data.slice()), close: () => { closed++; }, reset: () => { reset++; },
  };
  const factory = create("4FD2A832-86C8-11D0-8FCA-00C04FD9189D");
  method(factory, 3, 0, 0, 8, 0, 0, out); const draw = u32(out);
  m.mem.dv.setUint32(out, 108, true); m.mem.dv.setUint32(out + 12, 16, true); m.mem.dv.setUint32(out + 8, 8, true);
  m.mem.dv.setUint32(out + 104, 0x200, true);
  method(draw, 6, out, out + 128, 0); const surface = u32(out + 128);
  for (let pass = 0; pass < 2; pass++) {
    chunks.length = 0;
    const movie = create("49C47CE5-9BA4-11D0-8212-00C04FC32C45");
    const name = m.sysAlloc(32); m.mem.u8.set(Buffer.from("movie.avi\0", "utf16le"), name);
    expect(method(movie, 12, 0, 0, 0)).toBe(0);
    expect(method(movie, 16, name, 0)).toBe(0);
    writeGuid(m, guid, "A35FF56A-9FDA-11D0-8FDF-00C04FD9189D");
    expect(method(movie, 4, guid, out)).toBe(0); const stream = u32(out);
    expect(method(stream, 13, 0, 0, 0, out)).toBe(0); const sample = u32(out);
    expect(method(movie, 7, 1)).toBe(0);
    for (let frame = 0; frame < 4; frame++) {
      expect(method(sample, 6, 0, 0, 0, 0)).toBe(0);
      method(sample, 8, out, 0); const source = u32(out);
      expect(method(surface, 5, 0, source, 0, 0, 0)).toBe(0);
      for (let i = 0; i < pixels.length; i++) {
        const off = frame * 16 * 8 * 3 + i * 3;
        expect(pixels[i]).toBe((reference[off] << 16) | (reference[off + 1] << 8) | reference[off + 2]);
      }
      method(source, 2);
    }
    expect(method(sample, 6, 0, 0, 0, 0)).toBe(0x40003);
    expect(Buffer.concat(chunks.map((b) => Buffer.from(b))).equals(Buffer.from(audio))).toBe(true);
    expect(method(movie, 7, 0)).toBe(0);
    method(sample, 2); method(stream, 2); method(movie, 2);
  }
  expect([opened, closed, reset]).toEqual([2, 2, 2]);
  const movie = create("49C47CE5-9BA4-11D0-8212-00C04FC32C45");
  const name = m.sysAlloc(32); m.mem.u8.set(Buffer.from("movie.avi\0", "utf16le"), name);
  expect(method(movie, 16, name, 0)).toBe(0);
  writeGuid(m, guid, "A35FF56A-9FDA-11D0-8FDF-00C04FD9189D");
  method(movie, 4, guid, out); const stream = u32(out);
  method(stream, 13, 0, 0, 0, out); const sample = u32(out);
  method(movie, 7, 1);
  expect(videoPlayback(m).playing).toBe(true);
  expect(videoPlayback(m).skipCurrent()).toBe(true);
  expect(videoPlayback(m).playing).toBe(false);
  expect(method(sample, 6, 0, 0, 0, 0)).toBe(0x40003);
  expect([opened, closed, reset]).toEqual([3, 3, 3]);
  videoPlayback(m).skipAll = true;
  method(movie, 7, 1);
  expect(method(sample, 6, 0, 0, 0, 0)).toBe(0x40003);
  expect(opened).toBe(3); // Suppressed videos never queue audio.
  videoPlayback(m).skipAll = false;
  method(movie, 7, 1);
  expect(videoPlayback(m).playing).toBe(true);
  expect(opened).toBe(4);
  method(movie, 7, 0);
  method(sample, 2); method(stream, 2); method(movie, 2);
});
