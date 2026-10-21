import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Indeo5Decoder } from "../src/codecs/indeo5";

const DIR = fileURLToPath(new URL("../_untrusted/samples/", import.meta.url));
const SAMPLES: [string, number, number][] = [
  ["Educ_Movie_DeadlyForce.avi", 240, 180],
  ["indeo5.avi", 320, 240],
  ["ESLOGO.AVI", 320, 240],
];

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function videoChunks(file: Uint8Array): Uint8Array[] {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const tag = (o: number) => String.fromCharCode(file[o], file[o + 1], file[o + 2], file[o + 3]);
  const out: Uint8Array[] = [];
  const walk = (start: number, end: number, inMovi: boolean): void => {
    for (let o = start; o + 8 <= end; ) {
      const id = tag(o), size = dv.getUint32(o + 4, true);
      if (id === "RIFF" || id === "LIST") walk(o + 12, Math.min(end, o + 8 + size), inMovi || tag(o + 8) === "movi");
      else if (inMovi && (id === "00dc" || id === "00db")) out.push(file.subarray(o + 8, o + 8 + size));
      o += 8 + size + (size & 1);
    }
  };
  walk(0, file.length, false);
  return out;
}

function firstDiff(a: Uint8Array, aStride: number, b: Uint8Array, bOff: number, w: number, h: number): string | null {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (a[y * aStride + x] !== b[bOff + y * w + x]) return `(${x},${y}) got ${a[y * aStride + x]} want ${b[bOff + y * w + x]}`;
    }
  }
  return null;
}

describe("Indeo5Decoder", () => {
  const ffmpeg = hasFfmpeg();

  for (const [name, w, h] of SAMPLES) {
    const path = join(DIR, name);

    it.skipIf(!ffmpeg || !existsSync(path))(`${name} matches ffmpeg bit-exactly`, () => {
      const ref = execFileSync("ffmpeg", ["-v", "error", "-i", path, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "yuv410p", "-"], { maxBuffer: 1 << 28 });
      const cw = (w + 3) >> 2, ch = (h + 3) >> 2, frameSize = w * h + 2 * cw * ch;
      const chunks = videoChunks(readFileSync(path));

      const dec = new Indeo5Decoder(w, h);
      const bad: string[] = [];
      let decoded = 0;
      chunks.forEach((chunk, i) => {
        const before = [dec.y.slice(), dec.u.slice(), dec.v.slice()];
        if (!dec.decode(chunk)) {
          if (![dec.y, dec.u, dec.v].every((p, k) => Buffer.from(p).equals(before[k]))) bad.push(`frame ${i} changed the picture without decoding`);
          return;
        }
        const base = decoded++ * frameSize;
        const planes: [string, Uint8Array, number, number, number, number][] = [
          ["Y", dec.y, dec.yStride, base, w, h],
          ["U", dec.u, dec.cStride, base + w * h, cw, ch],
          ["V", dec.v, dec.cStride, base + w * h + cw * ch, cw, ch],
        ];
        for (const [p, buf, stride, off, pw, ph] of planes) {
          const d = firstDiff(buf, stride, ref, off, pw, ph);
          if (d) bad.push(`frame ${i} ${p} ${d}`);
        }
      });

      expect(bad.slice(0, 5)).toEqual([]);
      expect(decoded * frameSize).toBe(ref.length);
    });
  }

  it("writes a bottom-up BGR24 DIB", () => {
    const dec = new Indeo5Decoder(6, 2);
    dec.y.fill(235);
    dec.y.fill(16, 0, dec.yStride);
    const stride = (6 * 3 + 3) & ~3;
    const out = new Uint8Array(stride * 2 + 1);
    dec.toBgr24(out, 1);
    expect([...out.subarray(1, 4)]).toEqual([255, 255, 255]);
    expect([...out.subarray(1 + stride, 4 + stride)]).toEqual([0, 0, 0]);
  });
});
