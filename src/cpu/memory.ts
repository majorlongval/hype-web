export const PAGE_SIZE = 0x1000;

export class Memory {
  readonly wasm: WebAssembly.Memory;
  readonly buf: ArrayBuffer;
  readonly u8: Uint8Array;
  readonly dv: DataView;
  readonly guestSize: number;
  readonly stateBase: number;

  constructor(guestSize: number, stateSize = 0x10000) {
    const total = guestSize + stateSize;
    const pages = Math.ceil(total / 65536);
    this.wasm = new WebAssembly.Memory({ initial: pages, maximum: pages });
    this.buf = this.wasm.buffer;
    this.u8 = new Uint8Array(this.buf);
    this.dv = new DataView(this.buf);
    this.guestSize = guestSize;
    this.stateBase = guestSize;
  }

  r8(a: number): number {
    return this.dv.getUint8(a);
  }
  r16(a: number): number {
    return this.dv.getUint16(a, true);
  }
  r32(a: number): number {
    return this.dv.getUint32(a, true);
  }
  w8(a: number, v: number): void {
    this.dv.setUint8(a, v);
  }
  w16(a: number, v: number): void {
    this.dv.setUint16(a, v, true);
  }
  w32(a: number, v: number): void {
    this.dv.setUint32(a, v, true);
  }

  readBytes(a: number, n: number): Uint8Array {
    return this.u8.slice(a, a + n);
  }
  writeBytes(a: number, data: Uint8Array): void {
    this.u8.set(data, a);
  }
  fill(a: number, n: number, v: number): void {
    this.u8.fill(v, a, a + n);
  }

  readCString(a: number, max = 0x10000): string {
    let s = "";
    for (let i = 0; i < max; i++) {
      const b = this.u8[a + i];
      if (b === 0 || b === undefined) break;
      s += String.fromCharCode(b);
    }
    return s;
  }
  readWString(a: number, max = 0x10000): string {
    let s = "";
    for (let i = 0; i < max; i++) {
      const w = this.dv.getUint16(a + i * 2, true);
      if (w === 0) break;
      s += String.fromCharCode(w);
    }
    return s;
  }
  writeCString(a: number, s: string): void {
    for (let i = 0; i < s.length; i++) this.u8[a + i] = s.charCodeAt(i) & 0xff;
    this.u8[a + s.length] = 0;
  }
  writeWString(a: number, s: string): void {
    for (let i = 0; i < s.length; i++) this.dv.setUint16(a + i * 2, s.charCodeAt(i), true);
    this.dv.setUint16(a + s.length * 2, 0, true);
  }
}
