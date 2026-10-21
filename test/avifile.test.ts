import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { PcmTrack, parseAvi } from "../src/media/avi";
import { Args, Machine, type Impl } from "../src/win32/machine";
import { registerAvifile } from "../src/win32/avifile";
import { DRIVE_FIXED, MemSource, VFS } from "../src/win32/vfs";

const W = 64, H = 48, FPS = 12, RATE = 22050;
const ROW = W * 3;
let stereo: Uint8Array, mono8: Uint8Array;
let refFrames: Uint8Array, refStereo: Uint8Array, refMono8: Uint8Array;

function ffmpeg(args: string[]): Buffer {
  return execFileSync("ffmpeg", ["-v", "error", ...args], { maxBuffer: 1 << 26 });
}

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "hype-avi-"));
  const a = join(dir, "stereo.avi"), b = join(dir, "mono8.avi");
  const video = ["-f", "lavfi", "-i", `testsrc=size=${W}x${H}:rate=${FPS}`];
  const audio = ["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=${RATE}`];
  ffmpeg([...video, ...audio, "-t", "1", "-c:v", "rawvideo", "-pix_fmt", "bgr24", "-c:a", "pcm_s16le", "-ac", "2", a]);
  ffmpeg([...video, ...audio, "-t", "1", "-c:v", "rawvideo", "-pix_fmt", "bgr24", "-c:a", "pcm_u8", "-ac", "1", b]);
  stereo = readFileSync(a);
  mono8 = readFileSync(b);
  refFrames = ffmpeg(["-i", a, "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]);
  refStereo = ffmpeg(["-i", a, "-f", "s16le", "-"]);
  refMono8 = ffmpeg(["-i", b, "-f", "u8", "-"]);
});

function refRow(frame: number, y: number): Uint8Array {
  const off = frame * ROW * H + y * ROW;
  return refFrames.subarray(off, off + ROW);
}

describe("parseAvi", () => {
  it("reads the header, both streams and their index", () => {
    const avi = parseAvi(new MemSource(stereo));

    expect(avi.width).toBe(W);
    expect(avi.height).toBe(H);
    expect(avi.streams.map((s) => s.type)).toEqual(["vids", "auds"]);

    const [v, s] = avi.streams;
    expect(v.chunks.length).toBe(FPS);
    expect(v.rate / v.scale).toBe(FPS);
    expect(v.chunks[0].key).toBe(true);
    expect(s.chunks.length).toBeGreaterThan(0);
  });

  it("decodes 16-bit stereo PCM bit-exactly across chunk boundaries", () => {
    const avi = parseAvi(new MemSource(stereo));
    const pcm = new PcmTrack(avi, avi.streams[1]);
    expect(pcm.frames * 4).toBe(refStereo.length);

    const out = new Uint8Array(refStereo.length);
    let pos = 0;
    while (pos < pcm.frames) pos += pcm.read(pos, 1000, out, pos * 4);
    expect(Buffer.from(out).equals(refStereo)).toBe(true);
  });

  it("widens 8-bit PCM to 16-bit", () => {
    const avi = parseAvi(new MemSource(mono8));
    const pcm = new PcmTrack(avi, avi.streams[1]);
    expect(pcm.blockAlign).toBe(2);

    const out = new Uint8Array(pcm.frames * 2);
    pcm.read(0, pcm.frames, out, 0);
    const dv = new DataView(out.buffer);
    for (const i of [0, 1, 777, pcm.frames - 1]) expect(dv.getInt16(i * 2, true)).toBe((refMono8[i] - 128) << 8);
  });
});

describe("avifil32 HLE", () => {
  let m: Machine;
  let scratch: number;

  const call = (name: string, ...args: number[]): number => {
    const defs = (m as unknown as { defs: Map<string, Map<string, [number, Impl]>> }).defs;
    const impl = defs.get("avifil32.dll")!.get(name)![1];
    args.forEach((v, i) => m.mem.dv.setUint32(scratch + i * 4, v >>> 0, true));
    return ((impl(m, new Args(m, scratch)) as number | undefined) ?? 0) >>> 0;
  };
  const u32 = (p: number) => m.mem.dv.getUint32(p, true);

  beforeAll(() => {
    const vfs = new VFS();
    vfs.addDrive({ letter: "C", type: DRIVE_FIXED, label: "T", serial: 1, fs: "FAT32" });
    vfs.addFile("C:\\movie.avi", new MemSource(stereo));
    vfs.cwd = "C:\\";
    m = new Machine(vfs, { now: () => 0, log: () => {} });
    registerAvifile(m);
    scratch = m.sysAlloc(64);
  });

  it("opens the file the way the game does and returns bottom-up 24-bit frames", () => {
    const out = m.sysAlloc(0x100);
    const name = m.sysString("movie.avi");

    expect(call("AVIFileOpenA", out, name, 0, 0)).toBe(0);
    const file = u32(out);
    expect(call("AVIFileInfoA", file, out + 4, 0x6c)).toBe(0);
    expect(u32(out + 4 + 0x0c)).toBe(2);

    expect(call("AVIFileGetStream", file, out, 0, 0)).toBe(0);
    const vids = u32(out);
    expect(call("AVIStreamInfoA", vids, out + 4, 0x8c)).toBe(0);
    expect(u32(out + 4 + 0x18) / u32(out + 4 + 0x14)).toBe(FPS);

    const gf = call("AVIStreamGetFrameOpen", vids, 0);
    expect(gf).not.toBe(0);
    for (const pos of [0, 1, 7, 3]) {
      const dib = call("AVIStreamGetFrame", gf, pos);
      expect(u32(dib)).toBe(40);
      expect(m.mem.dv.getUint16(dib + 14, true)).toBe(24);
      const bits = dib + 40;
      for (const y of [0, H / 2, H - 1]) {
        const got = m.mem.u8.subarray(bits + (H - 1 - y) * ROW, bits + (H - y) * ROW);
        expect(Buffer.from(got).equals(refRow(pos, y))).toBe(true);
      }
    }
    expect(call("AVIStreamGetFrame", gf, FPS)).toBe(0);
    call("AVIStreamGetFrameClose", gf);
  });

  it("reads PCM audio in the game's fixed-size blocks", () => {
    const out = m.sysAlloc(16);
    const name = m.sysString("C:\\movie.avi");
    call("AVIFileOpenA", out, name, 0, 0);
    call("AVIFileGetStream", u32(out), out, 0x73647561, 0);
    const auds = u32(out);

    const cb = out + 4;
    m.mem.dv.setInt32(cb, 0, true);
    expect(call("AVIStreamReadFormat", auds, 0, 0, cb)).toBe(0);
    expect(u32(cb)).toBe(18);
    const fmt = m.sysAlloc(18);
    call("AVIStreamReadFormat", auds, 0, fmt, cb);
    expect(m.mem.dv.getUint16(fmt, true)).toBe(1);
    expect(m.mem.dv.getUint16(fmt + 14, true)).toBe(16);

    const block = 0x1000, buf = m.malloc(block * 4);
    const got = new Uint8Array(refStereo.length);
    let pos = 0;
    for (;;) {
      expect(call("AVIStreamRead", auds, pos, block, buf, block * 4, out + 8, out + 12)).toBe(0);
      const n = u32(out + 12);
      if (n === 0) break;
      expect(u32(out + 8)).toBe(n * 4);
      got.set(m.mem.u8.subarray(buf, buf + n * 4), pos * 4);
      pos += n;
    }
    expect(pos * 4).toBe(refStereo.length);
    expect(Buffer.from(got).equals(refStereo)).toBe(true);
  });

  it("fails cleanly on a missing file", () => {
    const out = m.sysAlloc(4);
    expect(call("AVIFileOpenA", out, m.sysString("nope.avi"), 0, 0)).not.toBe(0);
    expect(u32(out)).toBe(0);
  });
});
