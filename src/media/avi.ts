import { type FileSource, readBytes } from "../win32/vfs";

export interface AviChunk {
  off: number;
  size: number;
  key: boolean;
}

export interface AviStream {
  index: number;
  type: string;
  handler: string;
  flags: number;
  priority: number;
  language: number;
  initialFrames: number;
  scale: number;
  rate: number;
  start: number;
  length: number;
  suggestedBuffer: number;
  quality: number;
  sampleSize: number;
  frame: [number, number, number, number];
  format: Uint8Array;
  name: string;
  chunks: AviChunk[];
}

export interface AviFile {
  src: FileSource;
  microSecPerFrame: number;
  maxBytesPerSec: number;
  flags: number;
  totalFrames: number;
  suggestedBuffer: number;
  width: number;
  height: number;
  streams: AviStream[];
}

const AVIIF_KEYFRAME = 0x10;

export function fourcc(u8: Uint8Array, off: number): string {
  return String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]);
}

function streamOf(id: string): number {
  const d0 = id.charCodeAt(0) - 48, d1 = id.charCodeAt(1) - 48;
  return d0 >= 0 && d0 <= 9 && d1 >= 0 && d1 <= 9 ? d0 * 10 + d1 : -1;
}

function isDataChunk(s: AviStream, id: string): boolean {
  const tag = id.slice(2);
  return s.type === "vids" ? tag === "dc" || tag === "db" : tag !== "pc";
}

function parseStrh(s: AviStream, b: Uint8Array): void {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  s.type = fourcc(b, 0);
  s.handler = fourcc(b, 4);
  s.flags = dv.getUint32(8, true);
  s.priority = dv.getUint16(12, true);
  s.language = dv.getUint16(14, true);
  s.initialFrames = dv.getUint32(16, true);
  s.scale = dv.getUint32(20, true);
  s.rate = dv.getUint32(24, true);
  s.start = dv.getUint32(28, true);
  s.length = dv.getUint32(32, true);
  s.suggestedBuffer = dv.getUint32(36, true);
  s.quality = dv.getUint32(40, true);
  s.sampleSize = dv.getUint32(44, true);
  if (b.length >= 56) s.frame = [dv.getInt16(48, true), dv.getInt16(50, true), dv.getInt16(52, true), dv.getInt16(54, true)];
}

function newStream(index: number): AviStream {
  return {
    index, type: "", handler: "", flags: 0, priority: 0, language: 0, initialFrames: 0, scale: 1, rate: 1, start: 0,
    length: 0, suggestedBuffer: 0, quality: 0, sampleSize: 0, frame: [0, 0, 0, 0], format: new Uint8Array(0), name: "", chunks: [],
  };
}

export function parseAvi(src: FileSource): AviFile {
  const head = readBytes(src, 0, 12);
  if (head.length < 12 || fourcc(head, 0) !== "RIFF" || fourcc(head, 8) !== "AVI ") throw new Error("not an AVI file");
  const avi: AviFile = { src, microSecPerFrame: 0, maxBytesPerSec: 0, flags: 0, totalFrames: 0, suggestedBuffer: 0, width: 0, height: 0, streams: [] };
  const riffEnd = Math.min(src.size, 8 + new DataView(head.buffer).getUint32(4, true));
  let movi = -1, moviEnd = -1, idx1 = -1, idx1Size = 0;

  const walk = (start: number, end: number, inStrl: AviStream | null): void => {
    let pos = start;
    while (pos + 8 <= end) {
      const h = readBytes(src, pos, 12);
      const id = fourcc(h, 0);
      const size = new DataView(h.buffer).getUint32(4, true);
      const data = pos + 8;
      if (id === "LIST" || id === "RIFF") {
        const kind = fourcc(h, 8);
        if (kind === "movi") {
          movi = data;
          moviEnd = Math.min(end, data + size);
        } else if (kind === "strl") {
          const s = newStream(avi.streams.length);
          avi.streams.push(s);
          walk(data + 4, Math.min(end, data + size), s);
        } else if (kind === "hdrl" || kind === "AVI " || kind === "AVIX") walk(data + 4, Math.min(end, data + size), null);
      } else if (id === "avih") {
        const b = readBytes(src, data, Math.min(size, 56));
        const dv = new DataView(b.buffer);
        avi.microSecPerFrame = dv.getUint32(0, true);
        avi.maxBytesPerSec = dv.getUint32(4, true);
        avi.flags = dv.getUint32(12, true);
        avi.totalFrames = dv.getUint32(16, true);
        avi.suggestedBuffer = dv.getUint32(28, true);
        avi.width = dv.getUint32(32, true);
        avi.height = dv.getUint32(36, true);
      } else if (id === "strh" && inStrl) parseStrh(inStrl, readBytes(src, data, Math.min(size, 64)));
      else if (id === "strf" && inStrl) inStrl.format = readBytes(src, data, size);
      else if (id === "strn" && inStrl) {
        const b = readBytes(src, data, size);
        const z = b.indexOf(0);
        inStrl.name = String.fromCharCode(...b.subarray(0, z < 0 ? b.length : z));
      } else if (id === "idx1" && idx1 < 0) {
        idx1 = data;
        idx1Size = size;
      }
      pos = data + size + (size & 1);
    }
  };
  walk(12, riffEnd, null);
  if (movi < 0) throw new Error("AVI has no movi list");

  if (idx1 >= 0 && idx1Size >= 16) readIdx1(avi, idx1, idx1Size, movi);
  else scanMovi(avi, movi + 4, moviEnd);
  return avi;
}

function readIdx1(avi: AviFile, off: number, size: number, movi: number): void {
  const b = readBytes(avi.src, off, size - (size % 16));
  const dv = new DataView(b.buffer);
  let base = movi;
  if (b.length >= 16) {
    const first = dv.getUint32(8, true);
    const probe = readBytes(avi.src, first, 4);
    if (probe.length === 4 && fourcc(probe, 0) === fourcc(b, 0)) base = 0;
  }
  for (let p = 0; p + 16 <= b.length; p += 16) {
    const id = fourcc(b, p);
    const n = streamOf(id);
    const s = avi.streams[n];
    if (!s || !isDataChunk(s, id)) continue;
    const flags = dv.getUint32(p + 4, true);
    s.chunks.push({ off: base + dv.getUint32(p + 8, true) + 8, size: dv.getUint32(p + 12, true), key: (flags & AVIIF_KEYFRAME) !== 0 || s.type !== "vids" });
  }
}

function scanMovi(avi: AviFile, start: number, end: number): void {
  let pos = start;
  while (pos + 8 <= end) {
    const h = readBytes(avi.src, pos, 12);
    if (h.length < 8) return;
    const id = fourcc(h, 0);
    const size = new DataView(h.buffer).getUint32(4, true);
    if (id === "LIST") {
      scanMovi(avi, pos + 12, Math.min(end, pos + 8 + size));
    } else {
      const s = avi.streams[streamOf(id)];
      if (s && isDataChunk(s, id)) s.chunks.push({ off: pos + 8, size, key: s.type !== "vids" || s.chunks.length === 0 });
    }
    pos += 8 + size + (size & 1);
  }
}

export interface WaveFormat {
  tag: number;
  channels: number;
  rate: number;
  avgBytes: number;
  blockAlign: number;
  bits: number;
}

export function waveFormat(b: Uint8Array): WaveFormat {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return {
    tag: dv.getUint16(0, true),
    channels: dv.getUint16(2, true),
    rate: dv.getUint32(4, true),
    avgBytes: dv.getUint32(8, true),
    blockAlign: dv.getUint16(12, true),
    bits: b.length >= 16 ? dv.getUint16(14, true) : 8,
  };
}

export class PcmTrack {
  readonly channels: number;
  readonly rate: number;
  readonly frames: number;
  private readonly bytesPerSample: number;
  private readonly inAlign: number;
  private readonly firstFrame: number[] = [];

  constructor(
    private readonly avi: AviFile,
    private readonly stream: AviStream,
  ) {
    const wf = waveFormat(stream.format);
    if (wf.tag !== 1 || (wf.bits !== 8 && wf.bits !== 16) || wf.channels < 1) throw new Error(`unsupported audio format tag ${wf.tag}/${wf.bits} bit`);
    this.channels = wf.channels;
    this.rate = wf.rate;
    this.bytesPerSample = wf.bits / 8;
    this.inAlign = wf.channels * this.bytesPerSample;
    let total = 0;
    for (const c of stream.chunks) {
      this.firstFrame.push(total);
      total += Math.floor(c.size / this.inAlign);
    }
    this.frames = total;
  }

  get blockAlign(): number {
    return this.channels * 2;
  }

  format(): Uint8Array {
    const b = new Uint8Array(18);
    const dv = new DataView(b.buffer);
    dv.setUint16(0, 1, true);
    dv.setUint16(2, this.channels, true);
    dv.setUint32(4, this.rate, true);
    dv.setUint32(8, this.rate * this.blockAlign, true);
    dv.setUint16(12, this.blockAlign, true);
    dv.setUint16(14, 16, true);
    return b;
  }

  read(start: number, count: number, out: Uint8Array, outOff: number): number {
    const n = Math.max(0, Math.min(count, this.frames - start));
    if (n === 0) return 0;
    let lo = 0, hi = this.firstFrame.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.firstFrame[mid] <= start) lo = mid;
      else hi = mid - 1;
    }
    const dv = new DataView(out.buffer, out.byteOffset);
    let done = 0;
    for (let ci = lo; done < n && ci < this.stream.chunks.length; ci++) {
      const c = this.stream.chunks[ci];
      const skip = start + done - this.firstFrame[ci];
      const take = Math.min(n - done, Math.floor(c.size / this.inAlign) - skip);
      if (take <= 0) continue;
      const raw = readBytes(this.avi.src, c.off + skip * this.inAlign, take * this.inAlign);
      const dst = outOff + done * this.blockAlign;
      if (this.bytesPerSample === 2) out.set(raw, dst);
      else for (let i = 0; i < raw.length; i++) dv.setInt16(dst + i * 2, (raw[i] - 128) << 8, true);
      done += take;
    }
    return done;
  }
}
