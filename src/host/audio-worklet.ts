import type { ToWorklet } from "./protocol";

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

interface Stream {
  rate: number;
  channels: number;
  chunks: Float32Array[];
  pos: number;
  frames: number;
  priming: boolean;
}

const START_SEC = 0.06;
const MAX_SEC = 0.5;
const TRIM_SEC = 0.2;

class HypeAudio extends AudioWorkletProcessor {
  private streams = new Map<number, Stream>();

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<ToWorklet>) => {
      const msg = e.data;
      if (msg.t === "open") this.streams.set(msg.id, { rate: msg.rate, channels: msg.channels, chunks: [], pos: 0, frames: 0, priming: true });
      else if (msg.t === "close") this.streams.delete(msg.id);
      else if (msg.t === "reset") {
        const s = this.streams.get(msg.id);
        if (s) Object.assign(s, { chunks: [], pos: 0, frames: 0, priming: true });
      } else {
        const s = this.streams.get(msg.id);
        if (!s) return;
        s.chunks.push(msg.data);
        s.frames += msg.data.length / s.channels;
        if (s.frames > s.rate * MAX_SEC) {
          while (s.chunks.length > 1 && s.frames > s.rate * TRIM_SEC) {
            const c = s.chunks.shift()!;
            s.frames -= c.length / s.channels - s.pos;
            s.pos = 0;
          }
        }
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const left = out[0], right = out[1] ?? out[0];
    left.fill(0);
    if (right !== left) right.fill(0);
    for (const s of this.streams.values()) {
      if (s.priming) {
        if (s.frames < s.rate * START_SEC) continue;
        s.priming = false;
      }
      const step = s.rate / sampleRate;
      for (let i = 0; i < left.length; i++) {
        const c = s.chunks[0];
        if (!c) {
          s.priming = true;
          break;
        }
        const n = c.length / s.channels;
        const k = Math.floor(s.pos);
        if (s.channels === 2) {
          left[i] += c[k * 2];
          right[i] += c[k * 2 + 1];
        } else {
          left[i] += c[k];
          if (right !== left) right[i] += c[k];
        }
        s.pos += step;
        if (s.pos >= n) {
          s.pos -= n;
          s.frames -= n;
          s.chunks.shift();
        }
      }
    }
    return true;
  }
}

registerProcessor("hype-audio", HypeAudio);
