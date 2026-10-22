import type { Machine, Args, Impl } from "./machine";
import { waitFor } from "./machine";
import { comObject, readGuid, E_NOINTERFACE, E_NOTIMPL } from "./com";
import { parseAvi, PcmTrack, type AviFile, type AviStream } from "../media/avi";
import { createVideoDecoder, dibStride, type VideoDecoder } from "../codecs/video";
import { readBytes } from "./vfs";
import { glide } from "./glide3x";
import { mm } from "./winmm";

const FACTORY = "4FD2A832-86C8-11D0-8FCA-00C04FD9189D";
const MULTIMEDIA = "49C47CE5-9BA4-11D0-8212-00C04FC32C45";
const UNKNOWN = "00000000-0000-0000-C000-000000000046";
const DDRAW = "6C14DB80-A733-11CE-A521-0020AF0BE560";
const DDRAW2 = "B3A6F3E0-2B43-11CF-A2DE-00AA00B93356";
const DDSURFACE = "6C14DB81-A733-11CE-A521-0020AF0BE560";
const DDMEDIA = "F4104FCE-9A70-11D0-8FDE-00C04FD9189D";
const PRIMARY_VIDEO = "A35FF56A-9FDA-11D0-8FDF-00C04FD9189D";
const END_OF_STREAM = 0x40003;

type Method = [string, number, Impl];
interface Surface { w: number; h: number; pixels?: Uint32Array; primary: boolean }
interface Movie {
  avi?: AviFile; video?: AviStream; decoder?: VideoDecoder; audio?: PcmTrack;
  start: number; frame: number; sent: number; running: boolean; audioId: number;
  stream?: number; audioOpen: boolean;
}
interface ObjectState { refs: number; kind: string; surface?: Surface; movie?: Movie; target?: number }

interface Playback { skipAll: boolean; skipCurrent(): boolean; readonly playing: boolean }
export function videoPlayback(m: Machine): Playback {
  return m.sub.videoPlayback ??= { skipAll: false, skipCurrent: () => false, playing: false };
}

/** DirectShow's legacy multimedia-stream API, backed by the same AVI/Indeo decoder as AVIFile. */
export function registerDirectShow(m: Machine): void {
  const objects = new Map<number, ObjectState>();
  let audioId = -1000;
  const put = (p: number, n: number) => { if (p) m.mem.dv.setUint32(p, n >>> 0, true); };
  const get = (a: Args) => objects.get(a.u(0))!;
  const rect = (p: number, w: number, h: number): number[] => p
    ? [0, 4, 8, 12].map((o) => m.mem.dv.getInt32(p + o, true)) : [0, 0, w, h];
  const stop = (movie: Movie) => {
    movie.running = false;
    if (movie.audioOpen) {
      mm(m).sink?.reset(movie.audioId);
      mm(m).sink?.close(movie.audioId);
      movie.audioOpen = false;
    }
  };
  const previous = videoPlayback(m);
  const playing = () => [...objects.values()].filter((o) => o.kind === "multimedia" && o.movie?.running).map((o) => o.movie!);
  m.sub.videoPlayback = {
    skipAll: previous.skipAll,
    get playing() { return playing().length > 0; },
    skipCurrent() { const movies = playing(); for (const movie of movies) stop(movie); return movies.length > 0; },
  } satisfies Playback;
  const base = (kind: string, iids: string[]): Method[] => [
    ["QueryInterface", 12, (_m, a) => {
      const id = readGuid(m, a.u(1));
      if (id !== UNKNOWN && !iids.includes(id)) { put(a.u(2), 0); return E_NOINTERFACE; }
      get(a).refs++; put(a.u(2), a.u(0)); return 0;
    }],
    ["AddRef", 4, (_m, a) => ++get(a).refs],
    ["Release", 4, (_m, a) => {
      const obj = get(a), refs = --obj.refs;
      if (!refs) {
        if (kind === "multimedia" && obj.movie) stop(obj.movie);
        if (kind === "sample" && obj.target) {
          const target = objects.get(obj.target);
          if (target && !--target.refs) { objects.delete(obj.target); m.processHeap.free(obj.target); }
        }
        objects.delete(a.u(0)); m.processHeap.free(a.u(0));
      }
      return refs;
    }],
  ];
  const make = (kind: string, methods: Method[], state: Omit<ObjectState, "refs" | "kind"> = {}) => {
    const p = comObject(m, `retail:${kind}`, methods);
    objects.set(p, { refs: 1, kind, ...state }); return p;
  };
  const unsupported = (name: string, count: number): Method => [name, count * 4, () => E_NOTIMPL];

  const desc = (p: number, s: Surface) => {
    // DDSURFACEDESC (DirectDraw 1/2): RGB32, no guest pixel allocation needed for stream samples.
    const size = m.mem.dv.getUint32(p, true);
    m.mem.u8.fill(0, p, p + Math.min(size, 108));
    put(p, 108); put(p + 4, 0x1007); put(p + 8, s.h); put(p + 12, s.w); put(p + 16, s.w * 4);
    put(p + 72, 32); put(p + 76, 0x40); put(p + 84, 32);
    put(p + 88, 0xff0000); put(p + 92, 0xff00); put(p + 96, 0xff);
    put(p + 104, s.primary ? 0x200 : 0x40);
  };
  const present = (dst: Surface, src: Surface, dp: number, sp: number) => {
    if (!src.pixels) return;
    const d = rect(dp, dst.w, dst.h), s = rect(sp, src.w, src.h);
    const w = Math.max(0, d[2] - d[0]), h = Math.max(0, d[3] - d[1]);
    if (!w || !h || w > 4096 || h > 4096) return;
    const pixels = new Uint32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const sx = Math.min(src.w - 1, Math.max(0, Math.floor(s[0] + x * (s[2] - s[0]) / w)));
      const sy = Math.min(src.h - 1, Math.max(0, Math.floor(s[1] + y * (s[3] - s[1]) / h)));
      pixels[y * w + x] = src.pixels[sy * src.w + sx];
    }
    if (dst.primary) {
      const g = glide(m);
      g.backend.lfbWrite(0, d[0], d[1], w, h, pixels, 5);
      m.frameReady = true; m.cpu.stopReq = true;
    } else { dst.w = w; dst.h = h; dst.pixels = pixels; }
  };
  const surfaceMethods: Method[] = [
    ...base("surface", [DDSURFACE]),
    unsupported("AddAttachedSurface", 2), unsupported("AddOverlayDirtyRect", 2),
    ["Blt", 24, (_m, a) => {
      const dst = get(a).surface!, src = objects.get(a.u(2))?.surface;
      if (src) present(dst, src, a.u(1), a.u(3));
      return 0;
    }],
    unsupported("BltBatch", 4), unsupported("BltFast", 6), unsupported("DeleteAttachedSurface", 3),
    unsupported("EnumAttachedSurfaces", 3), unsupported("EnumOverlayZOrders", 4), unsupported("Flip", 3),
    unsupported("GetAttachedSurface", 3), ["GetBltStatus", 8, () => 0],
    unsupported("GetCaps", 2), unsupported("GetClipper", 2), unsupported("GetColorKey", 3),
    unsupported("GetDC", 2), unsupported("GetFlipStatus", 2), unsupported("GetOverlayPosition", 3),
    unsupported("GetPalette", 2),
    ["GetPixelFormat", 8, (_m, a) => { const p = a.u(1); put(p, 32); put(p + 4, 0x40); put(p + 12, 32); put(p + 16, 0xff0000); put(p + 20, 0xff00); put(p + 24, 0xff); return 0; }],
    ["GetSurfaceDesc", 8, (_m, a) => { desc(a.u(1), get(a).surface!); return 0; }],
    ["Initialize", 12, () => 0], ["IsLost", 4, () => 0], unsupported("Lock", 5),
    unsupported("ReleaseDC", 2), ["Restore", 4, () => 0], ["SetClipper", 8, () => 0],
  ];
  const newSurface = (w: number, h: number, primary = false) => make("surface", surfaceMethods, { surface: { w, h, primary } });
  const drawMethods: Method[] = [
    ...base("draw", [DDRAW, DDRAW2, "618F8AD4-8B7A-11D0-8FCC-00C04FD9189D"]),
    unsupported("Compact", 1), unsupported("CreateClipper", 4), unsupported("CreatePalette", 5),
    ["CreateSurface", 16, (_m, a) => {
      const p = a.u(1); const w = m.mem.dv.getUint32(p + 12, true) || 640, h = m.mem.dv.getUint32(p + 8, true) || 480;
      const primary = !!(m.mem.dv.getUint32(p + 104, true) & 0x200);
      if (w > 4096 || h > 4096) return 0x80070057;
      put(a.u(2), newSurface(w, h, primary)); return 0;
    }],
    unsupported("DuplicateSurface", 3), unsupported("EnumDisplayModes", 5), unsupported("EnumSurfaces", 5),
    ["FlipToGDISurface", 4, () => 0], unsupported("GetCaps", 3),
    ["GetDisplayMode", 8, (_m, a) => { desc(a.u(1), { w: 640, h: 480, primary: true }); return 0; }],
    unsupported("GetFourCCCodes", 3), unsupported("GetGDISurface", 2), unsupported("GetMonitorFrequency", 2),
    unsupported("GetScanLine", 2), unsupported("GetVerticalBlankStatus", 2), ["Initialize", 8, () => 0],
    ["RestoreDisplayMode", 4, () => 0], ["SetCooperativeLevel", 12, () => 0], ["SetDisplayMode", 24, () => 0],
  ];
  const newDraw = () => make("draw", drawMethods);
  const factoryMethods: Method[] = [
    ...base("factory", ["4FD2A833-86C8-11D0-8FCA-00C04FD9189D"]),
    ["CreateDirectDraw", 28, (_m, a) => { put(a.u(6), newDraw()); return 0; }],
    unsupported("DirectDrawEnumerate", 3),
  ];

  const pumpAudio = (movie: Movie, seconds: number) => {
    const pcm = movie.audio;
    if (!pcm || !movie.audioOpen) return;
    const end = Math.min(pcm.frames, Math.ceil(seconds * pcm.rate));
    if (end <= movie.sent) return;
    const data = new Uint8Array((end - movie.sent) * pcm.blockAlign);
    const count = pcm.read(movie.sent, end - movie.sent, data, 0);
    mm(m).sink?.write(movie.audioId, data.subarray(0, count * pcm.blockAlign));
    movie.sent += count;
  };
  const sampleMethods: Method[] = [
    ...base("sample", ["F4104FCF-9A70-11D0-8FDE-00C04FD9189D", "B502D1BE-9A57-11D0-8FDE-00C04FD9189D"]),
    ["GetMediaStream", 8, (_m, a) => { const p = get(a).movie!.stream!; objects.get(p)!.refs++; put(a.u(1), p); return 0; }],
    ["GetSampleTimes", 16, (_m, a) => {
      const movie = get(a).movie!, video = movie.video!;
      const t = movie.frame * video.scale / video.rate * 1e7;
      for (const p of [a.u(1), a.u(2), a.u(3)]) if (p) m.mem.dv.setBigInt64(p, BigInt(Math.round(t)), true);
      return 0;
    }],
    unsupported("SetSampleTimes", 3),
    ["Update", 20, function* (_m, a) {
      const state = get(a), movie = state.movie!, video = movie.video!, dec = movie.decoder!;
      if (!movie.running) return END_OF_STREAM;
      if (movie.frame >= video.chunks.length) {
        const duration = video.chunks.length * video.scale / video.rate;
        pumpAudio(movie, duration);
        const end = movie.start + duration * 1000;
        if (m.now() < end) yield* waitFor(m, [], false, end - m.now());
        return END_OF_STREAM;
      }
      const due = movie.start + movie.frame * video.scale / video.rate * 1000;
      if (m.now() < due) yield* waitFor(m, [], false, due - m.now());
      if (!movie.running) return END_OF_STREAM;
      // Decode all dependencies when the renderer falls behind the audio clock.
      const target = Math.min(video.chunks.length - 1, Math.max(movie.frame, Math.floor((m.now() - movie.start) * video.rate / video.scale / 1000)));
      while (movie.frame <= target) {
        const c = video.chunks[movie.frame++];
        // Indeo null frames deliberately keep the previous decoded image.
        if (c.size) dec.decode(readBytes(movie.avi!.src, c.off, c.size));
      }
      const stride = dibStride(dec.width), dib = new Uint8Array(stride * dec.height);
      dec.writeDib24(dib, 0);
      const surface = objects.get(state.target!)!.surface!;
      surface.w = dec.width; surface.h = dec.height;
      const pixels = new Uint32Array(dec.width * dec.height);
      for (let y = 0; y < dec.height; y++) for (let x = 0; x < dec.width; x++) {
        const off = (dec.height - 1 - y) * stride + x * 3;
        pixels[y * dec.width + x] = (dib[off + 2] << 16) | (dib[off + 1] << 8) | dib[off];
      }
      surface.pixels = pixels;
      pumpAudio(movie, (m.now() - movie.start) / 1000 + 0.15);
      return 0;
    }],
    ["CompletionStatus", 12, (_m, a) => get(a).movie!.frame >= get(a).movie!.video!.chunks.length ? END_OF_STREAM : 0],
    ["GetSurface", 12, (_m, a) => { const p = get(a).target!; objects.get(p)!.refs++; put(a.u(1), p); return 0; }],
    ["SetRect", 8, () => 0],
  ];
  const mediaMethods: Method[] = [
    ...base("media", [DDMEDIA, "B502D1BD-9A57-11D0-8FDE-00C04FD9189D"]),
    unsupported("GetMultiMediaStream", 2), unsupported("GetInformation", 3), unsupported("SetSameFormat", 3),
    unsupported("AllocateSample", 3), unsupported("CreateSharedSample", 4), ["SendEndOfStream", 8, () => 0],
    ["GetFormat", 20, (_m, a) => {
      const movie = get(a).movie!;
      if (!movie.decoder) return 0x80004005;
      if (a.u(1)) desc(a.u(1), { w: movie.decoder.width, h: movie.decoder.height, primary: false });
      put(a.u(2), 0); put(a.u(4), 0); return 0;
    }],
    ["SetFormat", 12, () => 0], unsupported("GetDirectDraw", 2), ["SetDirectDraw", 8, () => 0],
    ["CreateSample", 20, (_m, a) => {
      const movie = get(a).movie!;
      const target = a.u(1) || newSurface(movie.decoder!.width, movie.decoder!.height);
      if (a.u(1)) objects.get(target)!.refs++;
      put(a.u(4), make("sample", sampleMethods, { movie, target })); return 0;
    }],
    ["GetTimePerFrame", 8, (_m, a) => { const v = get(a).movie!.video!; m.mem.dv.setBigInt64(a.u(1), BigInt(Math.round(v.scale / v.rate * 1e7)), true); return 0; }],
  ];
  const newMedia = (movie: Movie) => movie.stream ??= make("media", mediaMethods, { movie });
  const multimediaMethods: Method[] = [
    ...base("multimedia", ["BEBE595C-9A6F-11D0-8FDE-00C04FD9189D", "B502D1BC-9A57-11D0-8FDE-00C04FD9189D"]),
    ["GetInformation", 12, (_m, a) => { put(a.u(1), 1); put(a.u(2), 0); return 0; }],
    ["GetMediaStream", 12, (_m, a) => { if (readGuid(m, a.u(1)) !== PRIMARY_VIDEO) return 0x80040403; put(a.u(2), newMedia(get(a).movie!)); return 0; }],
    unsupported("EnumMediaStreams", 3),
    ["GetState", 8, (_m, a) => { put(a.u(1), +get(a).movie!.running); return 0; }],
    ["SetState", 8, (_m, a) => {
      const movie = get(a).movie!;
      if (!a.u(1)) { stop(movie); return 0; }
      if (videoPlayback(m).skipAll) { stop(movie); return 0; }
      movie.running = true; movie.start = m.now(); movie.frame = 0; movie.sent = 0;
      if (movie.audio) {
        const pcm = movie.audio; mm(m).sink?.open(movie.audioId, pcm.rate, pcm.channels, 16); movie.audioOpen = true;
        pumpAudio(movie, 0.15);
      }
      return 0;
    }],
    ["GetTime", 8, (_m, a) => { m.mem.dv.setBigInt64(a.u(1), BigInt(Math.round((m.now() - get(a).movie!.start) * 10000)), true); return 0; }],
    ["GetDuration", 8, (_m, a) => { const v = get(a).movie!.video!; m.mem.dv.setBigInt64(a.u(1), BigInt(Math.round(v.chunks.length * v.scale / v.rate * 1e7)), true); return 0; }],
    unsupported("Seek", 3), unsupported("GetEndOfStreamEventHandle", 2),
    ["Initialize", 16, () => 0], unsupported("GetFilterGraph", 2), unsupported("GetFilter", 2),
    ["AddMediaStream", 20, (_m, a) => { if (a.u(4)) put(a.u(4), newMedia(get(a).movie!)); return 0; }],
    ["OpenFile", 12, (_m, a) => {
      const name = m.mem.readWString(a.u(1));
      const node = m.vfs.lookup(name);
      if (!node || node.isDir) return 0x80070002;
      const movie = get(a).movie!;
      try {
        const avi = parseAvi({ size: node.length, read: (o, d, off, len) => node.read(o, d, off, len) });
        const video = avi.streams.find((s) => s.type === "vids");
        const decoder = video && createVideoDecoder(video.format);
        if (!video || !decoder) return 0x80040265;
        movie.avi = avi; movie.video = video; movie.decoder = decoder;
        const audio = avi.streams.find((s) => s.type === "auds");
        movie.audio = audio ? new PcmTrack(avi, audio) : undefined;
        m.log(`video: opened ${name} (${decoder.width}x${decoder.height}, ${video.chunks.length} frames${audio ? ", audio" : ""})`);
        return 0;
      } catch (e) { m.log(`video: ${e}`); return 0x80004005; }
    }],
    unsupported("OpenMoniker", 4), ["Render", 8, () => 0],
  ];
  m.register("ole32.dll", {
    CoCreateInstance: [20, (_m, a) => {
      const id = readGuid(m, a.u(0)); let p = 0;
      if (id === FACTORY) p = make("factory", factoryMethods);
      else if (id === MULTIMEDIA) p = make("multimedia", multimediaMethods, {
        movie: { start: 0, frame: 0, sent: 0, running: false, audioId: audioId--, audioOpen: false },
      });
      put(a.u(4), p);
      if (!p) { m.log(`CoCreateInstance(${id}) -> class not registered`); return 0x80040154; }
      return 0;
    }],
  });
  m.register("ddraw.dll", { DirectDrawCreate: [12, (_m, a) => { put(a.u(1), newDraw()); return 0; }] });
}
