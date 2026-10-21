import { Indeo5Decoder } from "./indeo5";

export interface BitmapInfo {
  width: number;
  height: number;
  bits: number;
  compression: string;
}

export interface VideoDecoder {
  readonly width: number;
  readonly height: number;
  decode(data: Uint8Array): boolean;
  writeDib24(out: Uint8Array, off: number): void;
}

export type VideoDecoderFactory = (bi: BitmapInfo, format: Uint8Array) => VideoDecoder | null;

export function bitmapInfo(b: Uint8Array): BitmapInfo {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const c = dv.getUint32(16, true);
  const compression = c === 0 ? "RGB " : String.fromCharCode(c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff, c >>> 24);
  return { width: dv.getInt32(4, true), height: dv.getInt32(8, true), bits: dv.getUint16(14, true), compression };
}

export function dibStride(width: number): number {
  return (width * 3 + 3) & ~3;
}

class Raw24 implements VideoDecoder {
  readonly height: number;
  private frame: Uint8Array;
  private readonly topDown: boolean;

  constructor(readonly width: number, height: number) {
    this.topDown = height < 0;
    this.height = Math.abs(height);
    this.frame = new Uint8Array(dibStride(width) * this.height);
  }

  decode(data: Uint8Array): boolean {
    if (data.length < this.frame.length) return false;
    this.frame = data.slice(0, this.frame.length);
    return true;
  }

  writeDib24(out: Uint8Array, off: number): void {
    if (!this.topDown) {
      out.set(this.frame, off);
      return;
    }
    const stride = dibStride(this.width);
    for (let y = 0; y < this.height; y++) out.set(this.frame.subarray(y * stride, (y + 1) * stride), off + (this.height - 1 - y) * stride);
  }
}

class Indeo5 implements VideoDecoder {
  private readonly dec: Indeo5Decoder;

  constructor(readonly width: number, readonly height: number) {
    this.dec = new Indeo5Decoder(width, height);
  }

  decode(data: Uint8Array): boolean {
    return this.dec.decode(data);
  }

  writeDib24(out: Uint8Array, off: number): void {
    this.dec.toBgr24(out, off);
  }
}

const factories = new Map<string, VideoDecoderFactory>([
  ["RGB ", (bi) => (bi.bits === 24 ? new Raw24(bi.width, bi.height) : null)],
  ["IV50", (bi) => new Indeo5(bi.width, Math.abs(bi.height))],
]);

export function createVideoDecoder(format: Uint8Array): VideoDecoder | null {
  if (format.length < 40) return null;
  const bi = bitmapInfo(format);
  const f = factories.get(bi.compression.toUpperCase());
  return f ? f(bi, format) : null;
}
