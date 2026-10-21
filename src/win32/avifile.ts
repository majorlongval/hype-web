import type { Machine } from "./machine";
import { type AviFile, type AviStream, PcmTrack, parseAvi, readBytes } from "../media/avi";
import { type VideoDecoder, bitmapInfo, createVideoDecoder, dibStride } from "../codecs/video";

const AVIERR_UNSUPPORTED = 0x80044065;
const AVIERR_BADHANDLE = 0x8004406c;
const AVIERR_FILEOPEN = 0x8004406f;
const AVIERR_NODATA = 0x80044073;
const AVIERR_BUFFERTOOSMALL = 0x80044074;
const AVISTREAMREAD_CONVENIENT = -1;
const FILEINFO_SIZE = 0x6c, STREAMINFO_SIZE = 0x8c, BIH_SIZE = 40;

interface FileObj {
  avi: AviFile;
  path: string;
}

interface StreamObj {
  file: FileObj;
  s: AviStream;
  pcm: PcmTrack | null;
}

interface FrameObj {
  stream: StreamObj;
  dec: VideoDecoder;
  dib: number;
  last: number;
}

function fourccValue(s: string): number {
  return (s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24)) >>> 0;
}

function writeAnsi(u8: Uint8Array, off: number, s: string, max: number): void {
  const n = Math.min(s.length, max - 1);
  for (let i = 0; i < n; i++) u8[off + i] = s.charCodeAt(i) & 0xff;
  u8[off + n] = 0;
}

export function registerAvifile(m0: Machine): void {
  const files = new Map<number, FileObj>();
  const streams = new Map<number, StreamObj>();
  const frames = new Map<number, FrameObj>();

  const copyOut = (m: Machine, dst: number, src: Uint8Array, size: number) => {
    m.mem.u8.fill(0, dst, dst + size);
    m.mem.u8.set(src.subarray(0, Math.min(size, src.length)), dst);
  };

  const fileInfo = (f: FileObj): Uint8Array => {
    const b = new Uint8Array(FILEINFO_SIZE);
    const dv = new DataView(b.buffer);
    const vids = f.avi.streams.find((s) => s.type === "vids");
    dv.setUint32(0x00, f.avi.maxBytesPerSec, true);
    dv.setUint32(0x04, f.avi.flags, true);
    dv.setUint32(0x08, 0x3, true);
    dv.setUint32(0x0c, f.avi.streams.length, true);
    dv.setUint32(0x10, f.avi.suggestedBuffer, true);
    dv.setUint32(0x14, f.avi.width, true);
    dv.setUint32(0x18, f.avi.height, true);
    dv.setUint32(0x1c, vids ? vids.scale : 1, true);
    dv.setUint32(0x20, vids ? vids.rate : 1, true);
    dv.setUint32(0x24, vids ? vids.length : f.avi.totalFrames, true);
    writeAnsi(b, 0x2c, "AVI file", 64);
    return b;
  };

  const streamInfo = (o: StreamObj): Uint8Array => {
    const s = o.s;
    const b = new Uint8Array(STREAMINFO_SIZE);
    const dv = new DataView(b.buffer);
    dv.setUint32(0x00, fourccValue(s.type), true);
    dv.setUint32(0x04, s.handler.length === 4 ? fourccValue(s.handler) : 0, true);
    dv.setUint32(0x08, s.flags, true);
    dv.setUint16(0x10, s.priority, true);
    dv.setUint16(0x12, s.language, true);
    dv.setUint32(0x14, o.pcm ? o.pcm.blockAlign : s.scale, true);
    dv.setUint32(0x18, o.pcm ? o.pcm.rate * o.pcm.blockAlign : s.rate, true);
    dv.setUint32(0x1c, s.start, true);
    dv.setUint32(0x20, o.pcm ? o.pcm.frames : Math.max(s.length, s.type === "vids" ? s.chunks.length : 0), true);
    dv.setUint32(0x24, s.initialFrames, true);
    dv.setUint32(0x28, s.suggestedBuffer, true);
    dv.setUint32(0x2c, s.quality, true);
    dv.setUint32(0x30, o.pcm ? o.pcm.blockAlign : s.sampleSize, true);
    for (let i = 0; i < 4; i++) dv.setInt32(0x34 + i * 4, s.frame[i], true);
    writeAnsi(b, 0x4c, s.name, 64);
    return b;
  };

  const decodeTo = (f: FrameObj, pos: number): boolean => {
    const chunks = f.stream.s.chunks;
    if (pos < 0 || pos >= chunks.length) return false;
    if (pos === f.last) return true;
    let from = pos;
    while (from > 0 && !chunks[from].key) from--;
    if (f.last >= from && f.last < pos) from = f.last + 1;
    const src = f.stream.file.avi.src;
    for (let i = from; i <= pos; i++) {
      const c = chunks[i];
      if (c.size > 0) f.dec.decode(readBytes(src, c.off, c.size));
    }
    f.last = pos;
    return true;
  };

  m0.register("avifil32.dll", {
    AVIFileInit: [0, () => {}],
    AVIFileExit: [0, () => {}],
    AVIFileOpenA: [16, (m, a) => {
      const pp = a.u(0), path = a.str(1) ?? "";
      m.mem.dv.setUint32(pp, 0, true);
      const node = m.vfs.lookup(path);
      if (!node || node.isDir) {
        m.log(`AVIFileOpen(${path}) -> not found`);
        return AVIERR_FILEOPEN;
      }
      try {
        const avi = parseAvi({ size: node.length, read: (o, d, off, len) => node.read(o, d, off, len) });
        const h = m.malloc(16);
        files.set(h, { avi, path });
        m.mem.dv.setUint32(pp, h, true);
        m.log(`AVIFileOpen(${path}) -> ${avi.streams.map((s) => `${s.type}:${s.type === "vids" ? bitmapInfo(s.format).compression : s.handler}/${s.chunks.length}`).join(" ")}`);
        return 0;
      } catch (e) {
        m.log(`AVIFileOpen(${path}) -> ${(e as Error).message}`);
        return AVIERR_FILEOPEN;
      }
    }],
    AVIFileRelease: [4, (m, a) => {
      if (files.delete(a.u(0))) m.processHeap.free(a.u(0));
      return 0;
    }],
    AVIFileInfoA: [12, (m, a) => {
      const f = files.get(a.u(0));
      if (!f) return AVIERR_BADHANDLE;
      copyOut(m, a.u(1), fileInfo(f), Math.min(a.u(2), FILEINFO_SIZE));
      return 0;
    }],
    AVIFileGetStream: [16, (m, a) => {
      const f = files.get(a.u(0)), pp = a.u(1), type = a.u(2), param = a.i(3);
      m.mem.dv.setUint32(pp, 0, true);
      if (!f) return AVIERR_BADHANDLE;
      const list = type === 0 ? f.avi.streams : f.avi.streams.filter((s) => fourccValue(s.type) === type);
      const s = list[param];
      if (!s) return AVIERR_NODATA;
      let pcm: PcmTrack | null = null;
      if (s.type === "auds") {
        try {
          pcm = new PcmTrack(f.avi, s);
        } catch (e) {
          m.log(`AVIFileGetStream(${f.path}#${s.index}) audio: ${(e as Error).message}`);
        }
      }
      const h = m.malloc(16);
      streams.set(h, { file: f, s, pcm });
      m.mem.dv.setUint32(pp, h, true);
      return 0;
    }],
    AVIStreamRelease: [4, (m, a) => {
      if (streams.delete(a.u(0))) m.processHeap.free(a.u(0));
      return 0;
    }],
    AVIStreamInfoA: [12, (m, a) => {
      const o = streams.get(a.u(0));
      if (!o) return AVIERR_BADHANDLE;
      copyOut(m, a.u(1), streamInfo(o), Math.min(a.u(2), STREAMINFO_SIZE));
      return 0;
    }],
    AVIStreamReadFormat: [16, (m, a) => {
      const o = streams.get(a.u(0)), dst = a.u(2), pcb = a.u(3);
      if (!o) return AVIERR_BADHANDLE;
      const fmt = o.pcm ? o.pcm.format() : o.s.format;
      if (dst) copyOut(m, dst, fmt, Math.min(m.mem.dv.getInt32(pcb, true), fmt.length));
      m.mem.dv.setInt32(pcb, fmt.length, true);
      return 0;
    }],
    AVIStreamRead: [28, (m, a) => {
      const o = streams.get(a.u(0));
      const start = a.i(1), buf = a.u(3), cb = a.u(4), pBytes = a.u(5), pSamples = a.u(6);
      let count = a.i(2);
      const result = (bytes: number, samples: number, err = 0) => {
        if (pBytes) m.mem.dv.setInt32(pBytes, bytes, true);
        if (pSamples) m.mem.dv.setInt32(pSamples, samples, true);
        return err;
      };
      if (!o) return result(0, 0, AVIERR_BADHANDLE);
      if (o.pcm) {
        const align = o.pcm.blockAlign;
        const local = Math.max(0, start - o.s.start);
        if (count === AVISTREAMREAD_CONVENIENT) count = Math.floor(o.pcm.rate / 10);
        count = Math.max(0, Math.min(count, o.pcm.frames - local));
        if (!buf) return result(count * align, count);
        const fit = Math.floor(cb / align);
        if (fit === 0 && count > 0) return result(0, 0, AVIERR_BUFFERTOOSMALL);
        const n = o.pcm.read(local, Math.min(count, fit), m.mem.u8, buf);
        return result(n * align, n);
      }
      if (o.s.type === "auds") return result(0, 0, AVIERR_UNSUPPORTED);
      const c = o.s.chunks[start - o.s.start];
      if (!c) return result(0, 0, AVIERR_NODATA);
      if (!buf) return result(c.size, 1);
      if (cb < c.size) return result(c.size, 1, AVIERR_BUFFERTOOSMALL);
      m.mem.u8.set(readBytes(o.file.avi.src, c.off, c.size), buf);
      return result(c.size, 1);
    }],
    AVIStreamGetFrameOpen: [8, (m, a) => {
      const o = streams.get(a.u(0));
      if (!o || o.s.type !== "vids") return 0;
      const dec = createVideoDecoder(o.s.format);
      if (!dec) {
        m.log(`AVIStreamGetFrameOpen(${o.file.path}): no decoder for ${bitmapInfo(o.s.format).compression}`);
        return 0;
      }
      if (a.u(1)) m.log("AVIStreamGetFrameOpen: requested format ignored, returning 24-bit DIBs");
      const size = dibStride(dec.width) * dec.height;
      const dib = m.malloc(BIH_SIZE + size);
      const dv = m.mem.dv;
      dv.setUint32(dib, BIH_SIZE, true);
      dv.setInt32(dib + 4, dec.width, true);
      dv.setInt32(dib + 8, dec.height, true);
      dv.setUint16(dib + 12, 1, true);
      dv.setUint16(dib + 14, 24, true);
      dv.setUint32(dib + 20, size, true);
      const h = m.malloc(16);
      frames.set(h, { stream: o, dec, dib, last: -1 });
      return h;
    }],
    AVIStreamGetFrame: [8, (m, a) => {
      const f = frames.get(a.u(0));
      if (!f || !decodeTo(f, a.i(1) - f.stream.s.start)) return 0;
      f.dec.writeDib24(m.mem.u8, f.dib + BIH_SIZE);
      return f.dib;
    }],
    AVIStreamGetFrameClose: [4, (m, a) => {
      const f = frames.get(a.u(0));
      if (!f) return 0;
      frames.delete(a.u(0));
      m.processHeap.free(f.dib);
      m.processHeap.free(a.u(0));
      return 0;
    }],
  });
}
