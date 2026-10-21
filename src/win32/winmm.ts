import { Machine, waitFor } from "./machine";
import type { HleGen } from "./thread";
import { KEvent } from "./objects";
import { postMessage } from "./user32";
import { obj } from "./kernel32";

/** Receives PCM from waveOut. The browser host plays it; the Node host discards it. */
export interface AudioSink {
  open(id: number, rate: number, channels: number, bits: number): void;
  write(id: number, pcm: Uint8Array): void;
  close(id: number): void;
  reset(id: number): void;
}

interface WaveHdr {
  addr: number;
  bytes: number;
  endSample: number;
}

class WaveDev {
  queue: WaveHdr[] = [];
  queuedSamples = 0;
  clockStart = -1;
  pendingCallbacks: number[][] = [];
  paused = false;
  constructor(
    public handle: number,
    public rate: number,
    public channels: number,
    public bits: number,
    public cbType: number,
    public cb: number,
    public inst: number,
  ) {}
  get blockAlign(): number {
    return (this.channels * this.bits) / 8;
  }
}

interface MmTimer {
  id: number;
  delay: number;
  proc: number;
  user: number;
  flags: number;
  next: number;
  killed: boolean;
}

class WinmmState {
  devs = new Map<number, WaveDev>();
  nextDev = 0x4000;
  timers = new Map<number, MmTimer>();
  nextTimer = 1;
  sink: AudioSink | null = null;
  cbThreadStarted = false;
}

export function mm(m: Machine): WinmmState {
  return (m.sub.winmm ??= new WinmmState());
}

const WOM_OPEN = 0x3bb, WOM_CLOSE = 0x3bc, WOM_DONE = 0x3bd;
const WHDR_DONE = 1, WHDR_PREPARED = 2, WHDR_INQUEUE = 0x10;

function samplesPlayed(m: Machine, d: WaveDev): number {
  if (d.clockStart < 0) return 0;
  return Math.floor(((m.now() - d.clockStart) * d.rate) / 1000);
}

function complete(m: Machine, d: WaveDev, h: WaveHdr): void {
  const dv = m.mem.dv;
  const f = dv.getUint32(h.addr + 16, true);
  dv.setUint32(h.addr + 16, ((f | WHDR_DONE) & ~WHDR_INQUEUE) >>> 0, true);
  notify(m, d, WOM_DONE, h.addr);
}

function notify(m: Machine, d: WaveDev, msg: number, p1: number): void {
  const type = d.cbType & 0x70000;
  if (type === 0x50000) {
    const e = obj<KEvent>(m, d.cb);
    if (e) e.state = true;
  } else if (type === 0x30000) {
    d.pendingCallbacks.push([d.handle, msg, d.inst, p1, 0]);
    ensureCallbackThread(m);
  } else if (type === 0x20000) {
    const t = m.threads.find((x) => x.id === d.cb);
    if (t) postMessage(m, t, 0, msg, d.handle, p1);
  } else if (type === 0x10000) {
    const w = (m.sub.user32?.windows as Map<number, { thread: import("./thread").Thread }>)?.get(d.cb);
    if (w) postMessage(m, w.thread, d.cb, msg, d.handle, p1);
  }
}

function ensureCallbackThread(m: Machine): void {
  const s = mm(m);
  if (s.cbThreadStarted) return;
  s.cbThreadStarted = true;
  const wake = new KEvent(false, false);
  m.sub.waveWake = wake;
  m.createThread(0x10000, 0, 0, (function* (): HleGen {
    for (;;) {
      let any = false;
      for (const d of s.devs.values()) {
        while (d.pendingCallbacks.length) {
          any = true;
          const args = d.pendingCallbacks.shift()!;
          yield { t: "call", addr: d.cb, args };
        }
      }
      if (!any) yield* waitFor(m, [wake], false, 20);
    }
  })()).priority = 15;
}

function pollAudio(m: Machine): void {
  const s = mm(m);
  for (const d of s.devs.values()) {
    if (d.paused) continue;
    const played = samplesPlayed(m, d);
    while (d.queue.length && d.queue[0].endSample <= played) complete(m, d, d.queue.shift()!);
    if (!d.queue.length && d.clockStart >= 0 && played >= d.queuedSamples) {
      d.clockStart = -1;
      d.queuedSamples = 0;
    }
    if (d.pendingCallbacks.length && m.sub.waveWake) (m.sub.waveWake as KEvent).state = true;
  }
  for (const t of s.timers.values()) {
    if (t.killed || m.now() < t.next) continue;
    t.next = t.flags & 1 ? t.next + Math.max(1, t.delay) : Infinity;
    if (t.next < m.now() - 200) t.next = m.now() + t.delay;
    if (t.flags & 0x30) {
      const e = obj<KEvent>(m, t.proc);
      if (e) e.state = true;
    } else {
      (m.sub.mmTimerQueue ??= []).push(t);
      const wake = m.sub.mmTimerWake as KEvent | undefined;
      if (wake) wake.state = true;
    }
    if (!(t.flags & 1)) t.killed = true;
  }
}

function ensureTimerThread(m: Machine): void {
  if (m.sub.mmTimerWake) return;
  const wake = new KEvent(false, false);
  m.sub.mmTimerWake = wake;
  const t = m.createThread(0x10000, 0, 0, (function* (): HleGen {
    for (;;) {
      const q: MmTimer[] = m.sub.mmTimerQueue ?? [];
      if (!q.length) {
        yield* waitFor(m, [wake], false, 50);
        continue;
      }
      const tm = q.shift()!;
      if (tm.killed && tm.flags & 1) continue;
      yield { t: "call", addr: tm.proc, args: [tm.id, 0, tm.user, 0, 0] };
    }
  })());
  t.priority = 15;
  t.label = "mmtimer";
}

export function registerWinmm(m0: Machine): void {
  m0.pollers.push(() => pollAudio(m0));
  m0.register("winmm.dll", {
    timeGetTime: [0, (m) => Math.floor(m.now() - m.startTime + 3600000) >>> 0],
    timeBeginPeriod: [4, () => 0],
    timeEndPeriod: [4, () => 0],
    timeGetDevCaps: [8, (m, a) => {
      m.mem.dv.setUint32(a.u(0), 1, true);
      m.mem.dv.setUint32(a.u(0) + 4, 1000000, true);
      return 0;
    }],
    timeSetEvent: [20, (m, a) => {
      const s = mm(m);
      const t: MmTimer = { id: s.nextTimer++, delay: a.u(0), proc: a.u(2), user: a.u(3), flags: a.u(4), next: m.now() + a.u(0), killed: false };
      s.timers.set(t.id, t);
      if (!(t.flags & 0x30)) ensureTimerThread(m);
      return t.id;
    }],
    timeKillEvent: [4, (m, a) => {
      const t = mm(m).timers.get(a.u(0));
      if (!t) return 97;
      t.killed = true;
      mm(m).timers.delete(a.u(0));
      return 0;
    }],
    waveOutGetNumDevs: [0, () => 1],
    waveOutGetDevCapsA: [12, (m, a) => {
      const p = a.u(1), dv = m.mem.dv;
      m.mem.fill(p, Math.min(a.u(2), 52), 0);
      dv.setUint16(p, 1, true);
      dv.setUint16(p + 2, 2, true);
      dv.setUint32(p + 4, 0x0400, true);
      m.mem.writeCString(p + 8, "Web Audio");
      dv.setUint32(p + 40, 0xfff, true);
      dv.setUint16(p + 44, 2, true);
      dv.setUint32(p + 48, 0x0c, true);
      return 0;
    }],
    waveOutOpen: [24, (m, a) => {
      const fmt = a.u(2), dv = m.mem.dv;
      const tag = dv.getUint16(fmt, true), ch = dv.getUint16(fmt + 2, true), rate = dv.getUint32(fmt + 4, true);
      const bits = dv.getUint16(fmt + 14, true);
      if (tag !== 1 || (bits !== 8 && bits !== 16) || ch < 1 || ch > 2) return 32;
      if (a.u(5) & 1) return 0;
      const s = mm(m);
      const h = s.nextDev++;
      const d = new WaveDev(h, rate, ch, bits, a.u(5), a.u(3), a.u(4));
      s.devs.set(h, d);
      if (a.u(0)) dv.setUint32(a.u(0), h, true);
      s.sink?.open(h, rate, ch, bits);
      m.log(`waveOutOpen ${rate}Hz ${bits}bit ${ch}ch callback type ${(a.u(5) >> 16).toString(16)}`);
      notify(m, d, WOM_OPEN, 0);
      return 0;
    }],
    waveOutClose: [4, (m, a) => {
      const s = mm(m), d = s.devs.get(a.u(0));
      if (!d) return 5;
      notify(m, d, WOM_CLOSE, 0);
      s.sink?.close(d.handle);
      s.devs.delete(a.u(0));
      return 0;
    }],
    waveOutPrepareHeader: [12, (m, a) => {
      const f = m.mem.dv.getUint32(a.u(1) + 16, true);
      m.mem.dv.setUint32(a.u(1) + 16, (f | WHDR_PREPARED) & ~WHDR_DONE, true);
      return 0;
    }],
    waveOutUnprepareHeader: [12, (m, a) => {
      const f = m.mem.dv.getUint32(a.u(1) + 16, true);
      if (f & WHDR_INQUEUE) return 33;
      m.mem.dv.setUint32(a.u(1) + 16, f & ~WHDR_PREPARED, true);
      return 0;
    }],
    waveOutWrite: [12, (m, a) => {
      const d = mm(m).devs.get(a.u(0));
      if (!d) return 5;
      const h = a.u(1), dv = m.mem.dv;
      const data = dv.getUint32(h, true), len = dv.getUint32(h + 4, true);
      const f = dv.getUint32(h + 16, true);
      if (!(f & WHDR_PREPARED)) return 34;
      dv.setUint32(h + 16, (f | WHDR_INQUEUE) & ~WHDR_DONE, true);
      const samples = Math.floor(len / d.blockAlign);
      if (d.clockStart < 0) {
        d.clockStart = m.now();
        d.queuedSamples = 0;
      }
      d.queuedSamples += samples;
      d.queue.push({ addr: h, bytes: len, endSample: d.queuedSamples });
      mm(m).sink?.write(d.handle, m.mem.u8.slice(data, data + len));
      return 0;
    }],
    waveOutReset: [4, (m, a) => {
      const d = mm(m).devs.get(a.u(0));
      if (!d) return 5;
      while (d.queue.length) complete(m, d, d.queue.shift()!);
      d.clockStart = -1;
      d.queuedSamples = 0;
      mm(m).sink?.reset(d.handle);
      return 0;
    }],
    waveOutPause: [4, (m, a) => { const d = mm(m).devs.get(a.u(0)); if (d) d.paused = true; return 0; }],
    waveOutRestart: [4, (m, a) => { const d = mm(m).devs.get(a.u(0)); if (d) d.paused = false; return 0; }],
    waveOutGetPosition: [12, (m, a) => {
      const d = mm(m).devs.get(a.u(0));
      if (!d) return 5;
      const dv = m.mem.dv, p = a.u(1);
      const type = dv.getUint32(p, true);
      const s = Math.min(samplesPlayed(m, d), d.queuedSamples);
      if (type === 4) dv.setUint32(p + 4, s * d.blockAlign, true);
      else { dv.setUint32(p, 2, true); dv.setUint32(p + 4, s, true); }
      return 0;
    }],
    waveOutGetVolume: [8, (m, a) => { if (a.u(1)) m.mem.dv.setUint32(a.u(1), 0xffffffff, true); return 0; }],
    waveOutSetVolume: [8, () => 0],
    waveOutGetErrorTextA: [12, (m, a) => { m.mem.writeCString(a.u(1), `MM error ${a.u(0)}`); return 0; }],
    waveOutMessage: [16, () => 0],
    waveOutGetID: [8, (m, a) => { m.mem.dv.setUint32(a.u(1), 0, true); return 0; }],
    waveInGetNumDevs: [0, () => 0],
    midiOutGetNumDevs: [0, () => 0],
    auxGetNumDevs: [0, () => 0],
    mixerGetNumDevs: [0, () => 0],
    mixerOpen: [20, () => 6],
    mixerClose: [4, () => 0],
    mixerGetID: [12, () => 6],
    mixerGetDevCapsA: [12, () => 6],
    mixerGetLineInfoA: [12, () => 6],
    mixerGetLineControlsA: [12, () => 6],
    mixerGetControlDetailsA: [12, () => 6],
    mixerSetControlDetails: [12, () => 6],
    mciSendCommandA: [16, (m, a) => {
      m.log(`mciSendCommand dev=${a.u(0)} msg=${a.u(1).toString(16)} flags=${a.u(2).toString(16)}`);
      return 0x115;
    }],
    mciSendStringA: [16, (m, a) => { m.log(`mciSendString ${a.str(0)}`); return 0x115; }],
    mciGetErrorStringA: [12, (m, a) => { m.mem.writeCString(a.u(1), "MCI device not available"); return 1; }],
    PlaySoundA: [12, () => 1],
    sndPlaySoundA: [8, () => 1],
    joyGetNumDevs: [0, () => 0],
    joyGetPos: [8, () => 167],
    joyGetPosEx: [8, () => 167],
    joyGetDevCapsA: [12, () => 167],
  });
}
