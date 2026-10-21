// SPDX-License-Identifier: LGPL-2.1-or-later — port of FFmpeg's Indeo Video Interactive 5 decoder (libavcodec/indeo5.c, ivi.c), Copyright (c) 2009 Maxim Poliakovski.

import {
  BitReader, readVlc, toSigned, decHuffDesc, newRvmapTabs, mcPut, mcAdd, outputPlane, recompose53,
  inverseSlant8x8, inverseSlant4x4, rowSlant8, colSlant8, putPixels8x8,
  dcSlant2d, dcRowSlant, dcColSlant, putDcPixel8x8,
  ZIGZAG_8X8, VERTICAL_SCAN_8X8, HORIZONTAL_SCAN_8X8, DIRECT_SCAN_4X4,
  type RVMap, type InvTransform, type DcTransform,
} from "./ivi";

const INTRA = 0, INTER = 1, INTER_SCAL = 2, INTER_NOREF = 3, NULL_FRAME = 4;
const ERR = -1;

const PIC_SIZES = new Uint8Array([
  160, 120, 80, 60, 40, 30, 176, 120, 88, 60, 88, 72, 44, 36, 60, 45,
  160, 60, 176, 60, 20, 15, 22, 18, 0, 0, 0, 0, 0, 0,
]);

const BASE_8X8_INTER = new Uint16Array([
  0x26, 0x3a, 0x3e, 0x46, 0x4a, 0x4e, 0x52, 0x5a, 0x3a, 0x3e, 0x42, 0x46, 0x4a, 0x4e, 0x56, 0x5e,
  0x3e, 0x42, 0x46, 0x48, 0x4c, 0x52, 0x5a, 0x62, 0x46, 0x46, 0x48, 0x4a, 0x4e, 0x56, 0x5e, 0x66,
  0x4a, 0x4a, 0x4c, 0x4e, 0x52, 0x5a, 0x62, 0x6a, 0x4e, 0x4e, 0x52, 0x56, 0x5a, 0x5e, 0x66, 0x6e,
  0x52, 0x56, 0x5a, 0x5e, 0x62, 0x66, 0x6a, 0x72, 0x5a, 0x5e, 0x62, 0x66, 0x6a, 0x6e, 0x72, 0x76,
  0x26, 0x3a, 0x3e, 0x46, 0x4a, 0x4e, 0x52, 0x5a, 0x3a, 0x3e, 0x42, 0x46, 0x4a, 0x4e, 0x56, 0x5e,
  0x3e, 0x42, 0x46, 0x48, 0x4c, 0x52, 0x5a, 0x62, 0x46, 0x46, 0x48, 0x4a, 0x4e, 0x56, 0x5e, 0x66,
  0x4a, 0x4a, 0x4c, 0x4e, 0x52, 0x5a, 0x62, 0x6a, 0x4e, 0x4e, 0x52, 0x56, 0x5a, 0x5e, 0x66, 0x6e,
  0x52, 0x56, 0x5a, 0x5e, 0x62, 0x66, 0x6a, 0x72, 0x5a, 0x5e, 0x62, 0x66, 0x6a, 0x6e, 0x72, 0x76,
  0x4e, 0xaa, 0xf2, 0xd4, 0xde, 0xc2, 0xd6, 0xc2, 0x4e, 0xaa, 0xf2, 0xd4, 0xde, 0xc2, 0xd6, 0xc2,
  0x4e, 0xaa, 0xf2, 0xd4, 0xde, 0xc2, 0xd6, 0xc2, 0x4e, 0xaa, 0xf2, 0xd4, 0xde, 0xc2, 0xd6, 0xc2,
  0x4e, 0xaa, 0xf2, 0xd4, 0xde, 0xc2, 0xd6, 0xc2, 0x4e, 0xaa, 0xf2, 0xd4, 0xde, 0xc2, 0xd6, 0xc2,
  0x4e, 0xaa, 0xf2, 0xd4, 0xde, 0xc2, 0xd6, 0xc2, 0x4e, 0xaa, 0xf2, 0xd4, 0xde, 0xc2, 0xd6, 0xc2,
  0x4e, 0x4e, 0x4e, 0x4e, 0x4e, 0x4e, 0x4e, 0x4e, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa,
  0xf2, 0xf2, 0xf2, 0xf2, 0xf2, 0xf2, 0xf2, 0xf2, 0xd4, 0xd4, 0xd4, 0xd4, 0xd4, 0xd4, 0xd4, 0xd4,
  0xde, 0xde, 0xde, 0xde, 0xde, 0xde, 0xde, 0xde, 0xc2, 0xc2, 0xc2, 0xc2, 0xc2, 0xc2, 0xc2, 0xc2,
  0xd6, 0xd6, 0xd6, 0xd6, 0xd6, 0xd6, 0xd6, 0xd6, 0xc2, 0xc2, 0xc2, 0xc2, 0xc2, 0xc2, 0xc2, 0xc2,
  0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e,
  0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e,
  0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e,
  0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e,
]);

const BASE_8X8_INTRA = new Uint16Array([
  0x1a, 0x2e, 0x36, 0x42, 0x46, 0x4a, 0x4e, 0x5a, 0x2e, 0x32, 0x3e, 0x42, 0x46, 0x4e, 0x56, 0x6a,
  0x36, 0x3e, 0x3e, 0x44, 0x4a, 0x54, 0x66, 0x72, 0x42, 0x42, 0x44, 0x4a, 0x52, 0x62, 0x6c, 0x7a,
  0x46, 0x46, 0x4a, 0x52, 0x5e, 0x66, 0x72, 0x8e, 0x4a, 0x4e, 0x54, 0x62, 0x66, 0x6e, 0x86, 0xa6,
  0x4e, 0x56, 0x66, 0x6c, 0x72, 0x86, 0x9a, 0xca, 0x5a, 0x6a, 0x72, 0x7a, 0x8e, 0xa6, 0xca, 0xfe,
  0x26, 0x3a, 0x3e, 0x46, 0x4a, 0x4e, 0x52, 0x5a, 0x3a, 0x3e, 0x42, 0x46, 0x4a, 0x4e, 0x56, 0x5e,
  0x3e, 0x42, 0x46, 0x48, 0x4c, 0x52, 0x5a, 0x62, 0x46, 0x46, 0x48, 0x4a, 0x4e, 0x56, 0x5e, 0x66,
  0x4a, 0x4a, 0x4c, 0x4e, 0x52, 0x5a, 0x62, 0x6a, 0x4e, 0x4e, 0x52, 0x56, 0x5a, 0x5e, 0x66, 0x6e,
  0x52, 0x56, 0x5a, 0x5e, 0x62, 0x66, 0x6a, 0x72, 0x5a, 0x5e, 0x62, 0x66, 0x6a, 0x6e, 0x72, 0x76,
  0x4e, 0xaa, 0xf2, 0xd4, 0xde, 0xc2, 0xd6, 0xc2, 0x4e, 0xaa, 0xf2, 0xd4, 0xde, 0xc2, 0xd6, 0xc2,
  0x4e, 0xaa, 0xf2, 0xd4, 0xde, 0xc2, 0xd6, 0xc2, 0x4e, 0xaa, 0xf2, 0xd4, 0xde, 0xc2, 0xd6, 0xc2,
  0x4e, 0xaa, 0xf2, 0xd4, 0xde, 0xc2, 0xd6, 0xc2, 0x4e, 0xaa, 0xf2, 0xd4, 0xde, 0xc2, 0xd6, 0xc2,
  0x4e, 0xaa, 0xf2, 0xd4, 0xde, 0xc2, 0xd6, 0xc2, 0x4e, 0xaa, 0xf2, 0xd4, 0xde, 0xc2, 0xd6, 0xc2,
  0x4e, 0x4e, 0x4e, 0x4e, 0x4e, 0x4e, 0x4e, 0x4e, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa,
  0xf2, 0xf2, 0xf2, 0xf2, 0xf2, 0xf2, 0xf2, 0xf2, 0xd4, 0xd4, 0xd4, 0xd4, 0xd4, 0xd4, 0xd4, 0xd4,
  0xde, 0xde, 0xde, 0xde, 0xde, 0xde, 0xde, 0xde, 0xc2, 0xc2, 0xc2, 0xc2, 0xc2, 0xc2, 0xc2, 0xc2,
  0xd6, 0xd6, 0xd6, 0xd6, 0xd6, 0xd6, 0xd6, 0xd6, 0xc2, 0xc2, 0xc2, 0xc2, 0xc2, 0xc2, 0xc2, 0xc2,
  0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e,
  0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e,
  0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e,
  0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e, 0x5e,
]);

const BASE_4X4_INTER = new Uint16Array([
  0x1e, 0x3e, 0x4a, 0x52, 0x3e, 0x4a, 0x52, 0x56, 0x4a, 0x52, 0x56, 0x5e, 0x52, 0x56, 0x5e, 0x66,
]);

const BASE_4X4_INTRA = new Uint16Array([
  0x1e, 0x3e, 0x4a, 0x52, 0x3e, 0x4a, 0x52, 0x5e, 0x4a, 0x52, 0x5e, 0x7a, 0x52, 0x5e, 0x7a, 0x92,
]);

const SCALE_8X8_INTER = new Uint8Array([
  0x0b, 0x11, 0x13, 0x14, 0x15, 0x16, 0x18, 0x1a, 0x1b, 0x1d, 0x20, 0x22, 0x23, 0x25, 0x28, 0x2a,
  0x2e, 0x32, 0x35, 0x39, 0x3d, 0x41, 0x44, 0x4a, 0x07, 0x14, 0x16, 0x18, 0x1b, 0x1e, 0x22, 0x25,
  0x29, 0x2d, 0x31, 0x35, 0x3a, 0x3f, 0x44, 0x4a, 0x50, 0x56, 0x5c, 0x63, 0x6a, 0x71, 0x78, 0x7e,
  0x15, 0x25, 0x28, 0x2d, 0x30, 0x34, 0x3a, 0x3d, 0x42, 0x48, 0x4c, 0x51, 0x56, 0x5b, 0x60, 0x65,
  0x6b, 0x70, 0x76, 0x7c, 0x82, 0x88, 0x8f, 0x97, 0x13, 0x1f, 0x20, 0x22, 0x25, 0x28, 0x2b, 0x2d,
  0x30, 0x33, 0x36, 0x39, 0x3c, 0x3f, 0x42, 0x45, 0x48, 0x4b, 0x4e, 0x52, 0x56, 0x5a, 0x5e, 0x62,
  0x3c, 0x52, 0x58, 0x5d, 0x63, 0x68, 0x68, 0x6d, 0x73, 0x78, 0x7c, 0x80, 0x84, 0x89, 0x8e, 0x93,
  0x98, 0x9d, 0xa3, 0xa9, 0xad, 0xb1, 0xb5, 0xba,
]);

const SCALE_8X8_INTRA = new Uint8Array([
  0x0b, 0x0e, 0x10, 0x12, 0x14, 0x16, 0x17, 0x18, 0x1a, 0x1c, 0x1e, 0x20, 0x22, 0x24, 0x27, 0x28,
  0x2a, 0x2d, 0x2f, 0x31, 0x34, 0x37, 0x39, 0x3c, 0x01, 0x10, 0x12, 0x14, 0x16, 0x18, 0x1b, 0x1e,
  0x22, 0x25, 0x28, 0x2c, 0x30, 0x34, 0x38, 0x3d, 0x42, 0x47, 0x4c, 0x52, 0x58, 0x5e, 0x65, 0x6c,
  0x13, 0x22, 0x27, 0x2a, 0x2d, 0x33, 0x36, 0x3c, 0x41, 0x45, 0x49, 0x4e, 0x53, 0x58, 0x5d, 0x63,
  0x69, 0x6f, 0x75, 0x7c, 0x82, 0x88, 0x8e, 0x95, 0x13, 0x1f, 0x21, 0x24, 0x27, 0x29, 0x2d, 0x2f,
  0x34, 0x37, 0x3a, 0x3d, 0x40, 0x44, 0x48, 0x4c, 0x4f, 0x52, 0x56, 0x5a, 0x5e, 0x62, 0x66, 0x6b,
  0x31, 0x42, 0x47, 0x47, 0x4d, 0x52, 0x58, 0x58, 0x5d, 0x63, 0x67, 0x6b, 0x6f, 0x73, 0x78, 0x7c,
  0x80, 0x84, 0x89, 0x8e, 0x93, 0x98, 0x9d, 0xa4,
]);

const SCALE_4X4_INTER = new Uint8Array([
  0x0b, 0x0d, 0x0d, 0x0e, 0x11, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b,
  0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x21, 0x22, 0x23,
]);

const SCALE_4X4_INTRA = new Uint8Array([
  0x01, 0x0b, 0x0b, 0x0d, 0x0d, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
  0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
]);

class MbInfo {
  xpos: Int16Array;
  ypos: Int16Array;
  bufOffs: Int32Array;
  type: Uint8Array;
  cbp: Uint8Array;
  qDelta: Int8Array;
  mvX: Int8Array;
  mvY: Int8Array;

  constructor(n: number) {
    this.xpos = new Int16Array(n);
    this.ypos = new Int16Array(n);
    this.bufOffs = new Int32Array(n);
    this.type = new Uint8Array(n);
    this.cbp = new Uint8Array(n);
    this.qDelta = new Int8Array(n);
    this.mvX = new Int8Array(n);
    this.mvY = new Int8Array(n);
  }
}

interface Tile {
  xpos: number;
  ypos: number;
  width: number;
  height: number;
  mbSize: number;
  numMBs: number;
  mbs: MbInfo;
  ref: MbInfo | null;
}

class Band {
  bufs: (Int16Array | null)[] = [null, null, null, null];
  buf: Int16Array | null = null;
  refBuf: Int16Array | null = null;
  bufsize: number;
  isEmpty = 0;
  mbSize = 0;
  blkSize = 0;
  isHalfpel = 0;
  inheritMv = 0;
  inheritQdelta = 0;
  qdeltaPresent = 0;
  globQuant = 0;
  scan: Uint8Array | null = null;
  blkVlc: Int32Array | null = null;
  numCorr = 0;
  corr = new Uint8Array(122);
  rvmapSel = 0;
  rvMap: RVMap | null = null;
  tiles: Tile[] = [];
  invTransform: InvTransform | null = null;
  dcTransform: DcTransform | null = null;
  transformSize = 0;
  is2dTrans = false;
  intraBase: Uint16Array | null = null;
  interBase: Uint16Array | null = null;
  intraScale: Uint8Array | null = null;
  interScale: Uint8Array | null = null;

  constructor(readonly plane: number, readonly bandNum: number, readonly width: number, readonly height: number, readonly pitch: number, readonly aheight: number) {
    this.bufsize = pitch * aheight;
  }
}

interface Plane {
  width: number;
  height: number;
  bands: Band[];
}

interface PicConfig {
  picWidth: number;
  picHeight: number;
  chromaWidth: number;
  chromaHeight: number;
  tileWidth: number;
  tileHeight: number;
  lumaBands: number;
  chromaBands: number;
}

const sameConfig = (a: PicConfig, b: PicConfig) =>
  a.picWidth === b.picWidth && a.picHeight === b.picHeight && a.chromaWidth === b.chromaWidth && a.chromaHeight === b.chromaHeight &&
  a.tileWidth === b.tileWidth && a.tileHeight === b.tileHeight && a.lumaBands === b.lumaBands && a.chromaBands === b.chromaBands;

const mbsPerTile = (w: number, h: number, mb: number) => Math.floor((w + mb - 1) / mb) * Math.floor((h + mb - 1) / mb);

const scaleMv = (mv: number, s: number) => (mv + (mv > 0 ? 1 : 0) + (s - 1)) >> s;

const align = (v: number, a: number) => (v + a - 1) & -a;

export class Indeo5Decoder {
  private readonly br = new BitReader();
  private readonly rvmapTabs = newRvmapTabs();
  private readonly trvec = new Int32Array(64);
  private readonly colFlags = new Uint8Array(8);
  private planes: Plane[] = [];
  private cfg: PicConfig;
  private frameType = 0;
  private prevFrameType = 0;
  private frameFlags = 0;
  private gopFlags = 0;
  private isScalable = false;
  private interScal = 0;
  private bufSwitch = 0;
  private dstBuf = 0;
  private refBuf = 0;
  private ref2Buf = 0;
  private gopInvalid = 1;
  private readonly bufInvalid = [0, 0, 0, 0];
  private mbVlc: Int32Array | null = null;
  private prevDc = 0;
  private w: number;
  private h: number;
  private py: Uint8Array;
  private pu: Uint8Array;
  private pv: Uint8Array;
  private ys: number;
  private cs: number;

  constructor(width: number, height: number) {
    this.w = width;
    this.h = height;
    this.ys = this.cs = 0;
    this.py = this.pu = this.pv = new Uint8Array(0);
    this.allocPicture(width, height);
    this.cfg = {
      picWidth: width, picHeight: height, chromaWidth: (width + 3) >> 2, chromaHeight: (height + 3) >> 2,
      tileWidth: width, tileHeight: height, lumaBands: 1, chromaBands: 1,
    };
    this.initPlanes(this.cfg);
  }

  get width(): number { return this.w; }
  get height(): number { return this.h; }
  get y(): Uint8Array { return this.py; }
  get u(): Uint8Array { return this.pu; }
  get v(): Uint8Array { return this.pv; }
  get yStride(): number { return this.ys; }
  get cStride(): number { return this.cs; }

  decode(data: Uint8Array): boolean {
    if (!data.length) return false;
    this.br.reset(data);
    if (this.decodePicHdr()) return false;
    if (this.gopInvalid) return false;
    if (this.gopFlags & 0x20) return false;
    if (!this.planes.length) return false;

    this.switchBuffers();

    if (this.frameType !== NULL_FRAME) {
      this.bufInvalid[this.dstBuf] = 1;
      for (let p = 0; p < 3; p++) {
        for (const band of this.planes[p].bands) if (this.decodeBand(band) < 0) return false;
      }
      this.bufInvalid[this.dstBuf] = 0;
    } else {
      if (this.isScalable) return false;
      for (let p = 0; p < 3; p++) if (!this.planes[p].bands[0].buf) return false;
    }
    if (this.bufInvalid[this.dstBuf]) return false;
    if (this.frameType === NULL_FRAME) return false;

    const luma = this.planes[0];
    if (luma.width !== this.w || luma.height !== this.h) this.allocPicture(luma.width, luma.height);
    if (this.isScalable) {
      const b = luma.bands;
      recompose53(b[0].buf!, b[1].buf!, b[2].buf!, b[3].buf!, b[0].pitch, luma.width, luma.height, this.py, this.ys);
    } else {
      outputPlane(luma.bands[0].buf, luma.bands[0].pitch, luma.width, luma.height, this.py, this.ys);
    }
    const cb = this.planes[2], cr = this.planes[1];
    outputPlane(cb.bands[0].buf, cb.bands[0].pitch, cb.width, cb.height, this.pu, this.cs);
    outputPlane(cr.bands[0].buf, cr.bands[0].pitch, cr.width, cr.height, this.pv, this.cs);
    return true;
  }

  toBgr24(out: Uint8Array, offset: number): void {
    const w = this.w, h = this.h, stride = (w * 3 + 3) & ~3;
    const Y = this.py, U = this.pu, V = this.pv, ys = this.ys, cs = this.cs;
    const dst = new Uint8ClampedArray(out.buffer, out.byteOffset, out.length);
    for (let row = 0; row < h; row++) {
      let o = offset + (h - 1 - row) * stride;
      const yr = row * ys, cr = (row >> 2) * cs;
      for (let x = 0; x < w; x++) {
        const c = cr + (x >> 2);
        const yy = (Y[yr + x] - 16) * 76309 + 32768, uu = U[c] - 128, vv = V[c] - 128;
        dst[o++] = (yy + 132201 * uu) >> 16;
        dst[o++] = (yy - 25675 * uu - 53279 * vv) >> 16;
        dst[o++] = (yy + 104597 * vv) >> 16;
      }
    }
  }

  private allocPicture(width: number, height: number): void {
    this.w = width;
    this.h = height;
    this.ys = width + (width & 1);
    this.cs = (width + 3) >> 2;
    this.py = new Uint8Array(this.ys * (height + (height & 1)));
    this.pu = new Uint8Array(this.cs * ((height + 3) >> 2)).fill(128);
    this.pv = new Uint8Array(this.cs * ((height + 3) >> 2)).fill(128);
  }

  private initPlanes(cfg: PicConfig): number {
    this.planes = [];
    const w = cfg.picWidth, h = cfg.picHeight;
    if (w <= 0 || h <= 0 || (w + 128) * (h + 128) >= 0x7fffffff / 8 || cfg.lumaBands < 1 || cfg.chromaBands < 1) return ERR;
    const dims = [[w, h, cfg.lumaBands], [(w + 3) >> 2, (h + 3) >> 2, cfg.chromaBands], [(w + 3) >> 2, (h + 3) >> 2, cfg.chromaBands]];
    for (let p = 0; p < 3; p++) {
      const [pw, ph, n] = dims[p];
      const bw = n === 1 ? pw : (pw + 1) >> 1;
      const bh = n === 1 ? ph : (ph + 1) >> 1;
      const a = p ? 8 : 16;
      const bands: Band[] = [];
      for (let b = 0; b < n; b++) bands.push(new Band(p, b, bw, bh, align(bw, a), align(bh, a)));
      this.planes.push({ width: pw, height: ph, bands });
    }
    return 0;
  }

  private initTiles(tileWidth: number, tileHeight: number): number {
    for (let p = 0; p < 3; p++) {
      let tw = !p ? tileWidth : (tileWidth + 3) >> 2;
      let th = !p ? tileHeight : (tileHeight + 3) >> 2;
      if (!p && this.planes[0].bands.length === 4) {
        if (tw % 2 || th % 2) return ERR;
        tw >>= 1;
        th >>= 1;
      }
      if (tw <= 0 || th <= 0) return ERR;
      for (let b = 0; b < this.planes[p].bands.length; b++) {
        const band = this.planes[p].bands[b];
        band.tiles = [];
        const refTiles = this.planes[0].bands[0].tiles;
        let r = 0;
        for (let y = 0; y < band.height; y += th) {
          for (let x = 0; x < band.width; x += tw) {
            const width = Math.min(band.width - x, tw), height = Math.min(band.height - y, th);
            const numMBs = mbsPerTile(width, height, band.mbSize);
            const tile: Tile = { xpos: x, ypos: y, width, height, mbSize: band.mbSize, numMBs, mbs: new MbInfo(numMBs), ref: null };
            if (p || b) {
              if (numMBs !== refTiles[r].numMBs) return ERR;
              tile.ref = refTiles[r++].mbs;
            }
            band.tiles.push(tile);
          }
        }
      }
    }
    return 0;
  }

  private decodeGopHeader(): number {
    const br = this.br;
    this.gopFlags = br.get(8);
    if (this.gopFlags & 1) br.get(16);
    if (this.gopFlags & 0x20) br.get32();
    const tileSize = this.gopFlags & 0x40 ? 64 << br.get(2) : 0;
    if (tileSize > 256) return ERR;

    const lumaBands = br.get(2) * 3 + 1;
    const chromaBands = br.get(1) * 3 + 1;
    const isScalable = lumaBands !== 1 || chromaBands !== 1;
    if (isScalable && (lumaBands !== 4 || chromaBands !== 1)) return ERR;

    const sizeIdx = br.get(4);
    let picWidth, picHeight;
    if (sizeIdx === 15) {
      picHeight = br.get(13);
      picWidth = br.get(13);
    } else {
      picHeight = PIC_SIZES[sizeIdx * 2 + 1] << 2;
      picWidth = PIC_SIZES[sizeIdx * 2] << 2;
    }
    if (this.gopFlags & 2) return ERR;

    const cfg: PicConfig = {
      picWidth, picHeight, chromaWidth: (picWidth + 3) >> 2, chromaHeight: (picHeight + 3) >> 2,
      tileWidth: tileSize || picWidth, tileHeight: tileSize || picHeight, lumaBands, chromaBands,
    };

    let blkSizeChanged = false;
    if (!sameConfig(cfg, this.cfg) || this.gopInvalid) {
      if (this.initPlanes(cfg) < 0) return ERR;
      this.cfg = cfg;
      this.isScalable = isScalable;
      blkSizeChanged = true;
    }

    for (let p = 0; p <= 1; p++) {
      const n = !p ? lumaBands : chromaBands;
      for (let i = 0; i < n; i++) {
        const band = this.planes[p].bands[i];
        band.isHalfpel = br.get(1);
        const mbBit = br.get(1);
        const blkSize = 8 >> br.get(1);
        const mbSize = mbBit ? blkSize : blkSize << 1;
        if (p === 0 && blkSize === 4) return ERR;

        blkSizeChanged = mbSize !== band.mbSize || blkSize !== band.blkSize;
        if (blkSizeChanged) {
          band.mbSize = mbSize;
          band.blkSize = blkSize;
        }
        if (br.get(1)) return ERR;

        switch ((p << 2) + i) {
          case 0: band.invTransform = inverseSlant8x8; band.dcTransform = dcSlant2d; band.scan = ZIGZAG_8X8; band.transformSize = 8; break;
          case 1: band.invTransform = rowSlant8; band.dcTransform = dcRowSlant; band.scan = VERTICAL_SCAN_8X8; band.transformSize = 8; break;
          case 2: band.invTransform = colSlant8; band.dcTransform = dcColSlant; band.scan = HORIZONTAL_SCAN_8X8; band.transformSize = 8; break;
          case 3: band.invTransform = putPixels8x8; band.dcTransform = putDcPixel8x8; band.scan = HORIZONTAL_SCAN_8X8; band.transformSize = 8; break;
          case 4: band.invTransform = inverseSlant4x4; band.dcTransform = dcSlant2d; band.scan = DIRECT_SCAN_4X4; band.transformSize = 4; break;
        }
        band.is2dTrans = band.invTransform === inverseSlant8x8 || band.invTransform === inverseSlant4x4;
        if (band.transformSize !== band.blkSize) return ERR;

        const quantMat = !p ? (lumaBands > 1 ? i + 1 : 0) : 5;
        if (band.blkSize === 8) {
          if (quantMat >= 5) return ERR;
          band.intraBase = BASE_8X8_INTRA.subarray(quantMat * 64, quantMat * 64 + 64);
          band.interBase = BASE_8X8_INTER.subarray(quantMat * 64, quantMat * 64 + 64);
          band.intraScale = SCALE_8X8_INTRA.subarray(quantMat * 24, quantMat * 24 + 24);
          band.interScale = SCALE_8X8_INTER.subarray(quantMat * 24, quantMat * 24 + 24);
        } else {
          band.intraBase = BASE_4X4_INTRA;
          band.interBase = BASE_4X4_INTER;
          band.intraScale = SCALE_4X4_INTRA;
          band.interScale = SCALE_4X4_INTER;
        }
        if (br.get(2)) return ERR;
      }
    }

    for (let i = 0; i < chromaBands; i++) {
      const b1 = this.planes[1].bands[i], b2 = this.planes[2].bands[i];
      b2.mbSize = b1.mbSize;
      b2.blkSize = b1.blkSize;
      b2.isHalfpel = b1.isHalfpel;
      b2.intraBase = b1.intraBase;
      b2.interBase = b1.interBase;
      b2.intraScale = b1.intraScale;
      b2.interScale = b1.interScale;
      b2.scan = b1.scan;
      b2.invTransform = b1.invTransform;
      b2.dcTransform = b1.dcTransform;
      b2.is2dTrans = b1.is2dTrans;
      b2.transformSize = b1.transformSize;
    }

    if (blkSizeChanged && this.initTiles(cfg.tileWidth, cfg.tileHeight) < 0) return ERR;

    if (this.gopFlags & 8) {
      if (br.get(3)) return ERR;
      if (br.get(1)) br.skip(24);
    }
    br.align();
    br.skip(23);
    if (br.get(1)) {
      let v;
      do v = br.get(16);
      while (v & 0x8000);
    }
    br.align();
    return 0;
  }

  private skipHdrExtension(): number {
    const br = this.br;
    let len;
    do {
      len = br.get(8);
      if (8 * len > br.left()) return ERR;
      br.skip(8 * len);
    } while (len);
    return 0;
  }

  private decodePicHdr(): number {
    const br = this.br;
    if (br.get(5) !== 0x1f) return ERR;
    this.prevFrameType = this.frameType;
    this.frameType = br.get(3);
    if (this.frameType >= 5) {
      this.frameType = INTRA;
      return ERR;
    }
    br.get(8);
    if (this.frameType === INTRA) {
      if (this.decodeGopHeader() < 0) {
        this.gopInvalid = 1;
        return ERR;
      }
      this.gopInvalid = 0;
    }
    if (this.frameType === INTER_SCAL && !this.isScalable) {
      this.frameType = INTER;
      return ERR;
    }
    if (this.frameType !== NULL_FRAME) {
      this.frameFlags = br.get(8);
      if (this.frameFlags & 1) br.get(24);
      if (this.frameFlags & 0x10) br.get(16);
      if (this.frameFlags & 0x20) this.skipHdrExtension();
      const vlc = decHuffDesc(br, this.frameFlags & 0x40, false);
      if (!vlc) return ERR;
      this.mbVlc = vlc;
      br.skip(3);
    }
    br.align();
    return 0;
  }

  private decodeBandHdr(band: Band): number {
    const br = this.br;
    const flags = br.get(8);
    if (flags & 1) {
      band.isEmpty = 1;
      return 0;
    }
    if (this.frameFlags & 0x80) br.get(24);
    band.inheritMv = flags & 2;
    band.inheritQdelta = flags & 8;
    band.qdeltaPresent = flags & 4;
    if (!band.qdeltaPresent) band.inheritQdelta = 1;

    band.numCorr = 0;
    if (flags & 0x10) {
      band.numCorr = br.get(8);
      if (band.numCorr > 61) return ERR;
      for (let i = 0; i < band.numCorr * 2; i++) band.corr[i] = br.get(8);
    }
    band.rvmapSel = flags & 0x40 ? br.get(3) : 8;

    const vlc = decHuffDesc(br, flags & 0x80, true);
    if (!vlc) return ERR;
    band.blkVlc = vlc;

    if (br.get(1)) br.get(16);
    band.globQuant = br.get(5);
    if (flags & 0x20) {
      br.align();
      this.skipHdrExtension();
    }
    br.align();
    return 0;
  }

  private switchBuffers(): void {
    switch (this.prevFrameType) {
      case INTRA:
      case INTER:
        this.bufSwitch ^= 1;
        this.dstBuf = this.bufSwitch;
        this.refBuf = this.bufSwitch ^ 1;
        break;
      case INTER_SCAL:
        if (!this.interScal) {
          this.ref2Buf = 2;
          this.interScal = 1;
        }
        [this.dstBuf, this.ref2Buf] = [this.ref2Buf, this.dstBuf];
        this.refBuf = this.ref2Buf;
        break;
    }
    switch (this.frameType) {
      case INTRA:
        this.bufSwitch = 0;
      case INTER:
        this.interScal = 0;
        this.dstBuf = this.bufSwitch;
        this.refBuf = this.bufSwitch ^ 1;
        break;
    }
  }

  private prepareBuf(band: Band, i: number): Int16Array | null {
    if (this.cfg.lumaBands <= 1 && i === 2) return null;
    return (band.bufs[i] ??= new Int16Array(band.bufsize));
  }

  private applyCorrections(band: Band, rv: RVMap, reverse: boolean): void {
    for (let k = 0; k < band.numCorr; k++) {
      const i = reverse ? band.numCorr - 1 - k : k;
      const a = band.corr[i * 2], b = band.corr[i * 2 + 1];
      const r = rv.run[a]; rv.run[a] = rv.run[b]; rv.run[b] = r;
      const v = rv.val[a]; rv.val[a] = rv.val[b]; rv.val[b] = v;
      if (a === rv.eob || b === rv.eob) rv.eob ^= a ^ b;
      if (a === rv.esc || b === rv.esc) rv.esc ^= a ^ b;
    }
  }

  private decodeBand(band: Band): number {
    const br = this.br;
    band.buf = this.prepareBuf(band, this.dstBuf);
    if (!band.buf) return ERR;
    band.refBuf = this.prepareBuf(band, this.refBuf);
    if (!band.refBuf) return ERR;

    if (this.decodeBandHdr(band)) return ERR;
    if (band.isEmpty) return ERR;

    const rv = (band.rvMap = this.rvmapTabs[band.rvmapSel]);
    this.applyCorrections(band, rv, false);

    const lumaMb = this.planes[0].bands[0].mbSize;
    let pos = br.idx, result = 0;
    for (const tile of band.tiles) {
      if (tile.mbSize !== band.mbSize || lumaMb < band.mbSize) return ERR;
      if (br.get(1)) {
        result = this.processEmptyTile(band, tile, (lumaMb >> 3) - (band.mbSize >> 3));
        if (result < 0) break;
      } else {
        const dataSize = this.decTileDataSize();
        if (!dataSize) {
          result = ERR;
          break;
        }
        result = this.decodeMbInfo(band, tile);
        if (result < 0) break;
        result = this.decodeBlocks(band, tile);
        if (result < 0) break;
        if ((br.idx - pos) >> 3 !== dataSize) {
          result = ERR;
          break;
        }
        pos += dataSize << 3;
      }
    }

    this.applyCorrections(band, rv, true);
    br.align();
    return result;
  }

  private decTileDataSize(): number {
    const br = this.br;
    let len = 0;
    if (br.get(1)) {
      len = br.get(8);
      if (len === 255) len = br.get(24);
    }
    br.align();
    return len;
  }

  private decodeMbInfo(band: Band, tile: Tile): number {
    const br = this.br, mb = tile.mbs, ref = tile.ref, mbSize = band.mbSize, pitch = band.pitch;
    let offs = tile.ypos * pitch + tile.xpos;
    if (!ref && ((band.qdeltaPresent && band.inheritQdelta) || band.inheritMv)) return ERR;
    if (tile.numMBs !== mbsPerTile(tile.width, tile.height, mbSize)) return ERR;

    const mvScale = (this.planes[0].bands[0].mbSize >> 3) - (mbSize >> 3);
    const intra = this.frameType === INTRA;
    const lumaQ = !band.plane && !band.bandNum && (this.frameFlags & 8) !== 0;
    const inherit = band.inheritMv && ref;
    const blksPerMb = mbSize !== band.blkSize ? 4 : 1;
    const s = band.isHalfpel;
    const vlc = this.mbVlc!;
    let mvX = 0, mvY = 0, n = 0;

    for (let y = tile.ypos; y < tile.ypos + tile.height; y += mbSize) {
      let mbOffset = offs;
      for (let x = tile.xpos; x < tile.xpos + tile.width; x += mbSize, n++) {
        mb.xpos[n] = x;
        mb.ypos[n] = y;
        mb.bufOffs[n] = mbOffset;

        if (br.get(1)) {
          if (intra) return ERR;
          mb.type[n] = 1;
          mb.cbp[n] = 0;
          mb.qDelta[n] = lumaQ ? toSigned(readVlc(br, vlc)) : 0;
          mb.mvX[n] = mb.mvY[n] = 0;
          if (inherit) {
            mb.mvX[n] = mvScale ? scaleMv(ref.mvX[n], mvScale) : ref.mvX[n];
            mb.mvY[n] = mvScale ? scaleMv(ref.mvY[n], mvScale) : ref.mvY[n];
          }
        } else {
          if (inherit) mb.type[n] = ref.type[n];
          else if (intra) mb.type[n] = 0;
          else mb.type[n] = br.get(1);

          mb.cbp[n] = br.get(blksPerMb);
          mb.qDelta[n] = 0;
          if (band.qdeltaPresent) {
            if (band.inheritQdelta) {
              if (ref) mb.qDelta[n] = ref.qDelta[n];
            } else if (mb.cbp[n] || lumaQ) {
              mb.qDelta[n] = toSigned(readVlc(br, vlc));
            }
          }

          if (!mb.type[n]) {
            mb.mvX[n] = mb.mvY[n] = 0;
          } else if (inherit) {
            mb.mvX[n] = mvScale ? scaleMv(ref.mvX[n], mvScale) : ref.mvX[n];
            mb.mvY[n] = mvScale ? scaleMv(ref.mvY[n], mvScale) : ref.mvY[n];
          } else {
            mvY += toSigned(readVlc(br, vlc));
            mvX += toSigned(readVlc(br, vlc));
            mb.mvX[n] = mvX;
            mb.mvY[n] = mvY;
          }
        }

        if (mb.type[n]) {
          const mx = mb.mvX[n], my = mb.mvY[n];
          if (x + (mx >> s) + (y + (my >> s)) * pitch < 0 ||
              x + ((mx + s) >> s) + mbSize - 1 + (y + mbSize - 1 + ((my + s) >> s)) * pitch > band.bufsize - 1) return ERR;
        }
        mbOffset += mbSize;
      }
      offs += mbSize * pitch;
    }
    br.align();
    return 0;
  }

  private decodeBlocks(band: Band, tile: Tile): number {
    const mb = tile.mbs, blkSize = band.blkSize, pitch = band.pitch, mbSize = band.mbSize;
    const numBlocks = mbSize !== blkSize ? 4 : 1;
    const bufTotal = pitch * band.aheight;
    const minSize = (blkSize - 1) * pitch + blkSize;
    const hp = band.isHalfpel;
    const buf = band.buf!, ref = band.refBuf!;
    let mcType = 0, mvX = 0, mvY = 0;
    this.prevDc = 0;

    for (let n = 0; n < tile.numMBs; n++) {
      const isIntra = !mb.type[n];
      let cbp = mb.cbp[n], offs = mb.bufOffs[n];
      let quant = band.globQuant + mb.qDelta[n];
      quant = quant < 0 ? 0 : quant > 23 ? 23 : quant;
      const scaleTab = isIntra ? band.intraScale : band.interScale;
      if (scaleTab) quant = scaleTab[quant];

      if (!isIntra) {
        mvX = mb.mvX[n];
        mvY = mb.mvY[n];
        if (hp) {
          mcType = ((mvY & 1) << 1) | (mvX & 1);
          mvX >>= 1;
          mvY >>= 1;
        }
        const dmvX = mb.mvX[n] >> hp, dmvY = mb.mvY[n] >> hp, cx = mb.mvX[n] & hp, cy = mb.mvY[n] & hp;
        if (mb.xpos[n] + dmvX < 0 || mb.xpos[n] + dmvX + mbSize + cx > pitch ||
            mb.ypos[n] + dmvY < 0 || mb.ypos[n] + dmvY + mbSize + cy > band.aheight) return ERR;
      }

      for (let blk = 0; blk < numBlocks; blk++) {
        if (blk & 1) offs += blkSize;
        else if (blk === 2) offs += blkSize * pitch - blkSize;

        if (cbp & 1) {
          if (this.decodeCodedBlock(band, isIntra, quant, offs) < 0) return ERR;
          if (!isIntra) mcAdd(buf, offs, ref, offs + mvY * pitch + mvX, pitch, mcType, blkSize);
        } else {
          if (minSize > bufTotal - offs) return ERR;
          if (isIntra) band.dcTransform!(this.prevDc, buf, offs, pitch, blkSize);
          else mcPut(buf, offs, ref, offs + mvY * pitch + mvX, pitch, mcType, blkSize);
        }
        cbp >>= 1;
      }
    }
    this.br.align();
    return 0;
  }

  private decodeCodedBlock(band: Band, isIntra: boolean, quant: number, offs: number): number {
    const br = this.br, rv = band.rvMap!, vlc = band.blkVlc!, scan = band.scan, trvec = this.trvec, colFlags = this.colFlags;
    const baseTab = (isIntra ? band.intraBase : band.interBase)!;
    const blkSize = band.blkSize, numCoeffs = blkSize * blkSize, colMask = blkSize - 1;
    if (band.pitch * (band.transformSize - 1) + band.transformSize > band.pitch * band.aheight - offs) return ERR;
    if (!scan) return ERR;

    trvec.fill(0, 0, numCoeffs);
    colFlags.fill(0);
    let scanPos = -1, sym = 0;
    while (scanPos <= numCoeffs) {
      sym = readVlc(br, vlc);
      if (sym === rv.eob) break;
      let run, val;
      if (sym === rv.esc) {
        run = readVlc(br, vlc) + 1;
        const lo = readVlc(br, vlc);
        const hi = readVlc(br, vlc);
        val = toSigned((hi << 6) | lo);
      } else {
        if (sym < 0 || sym >= 256) return ERR;
        run = rv.run[sym];
        val = rv.val[sym];
      }
      scanPos += run;
      if (scanPos >= numCoeffs || scanPos < 0) break;
      const pos = scan[scanPos];
      const q = (baseTab[pos] * quant) >> 9;
      if (q > 1) val = (val * q + (val > 0 ? 1 : -1) * (((q ^ 1) - 1) >> 1)) | 0;
      trvec[pos] = val;
      if (val) colFlags[pos & colMask] = 1;
    }
    if (scanPos < 0 || (scanPos >= numCoeffs && sym !== rv.eob)) return ERR;

    if (isIntra && band.is2dTrans) {
      this.prevDc = (this.prevDc + trvec[0]) | 0;
      trvec[0] = this.prevDc;
      if (this.prevDc) colFlags[0] = 1;
    }
    band.invTransform!(trvec, band.buf!, offs, band.pitch, colFlags);
    return 0;
  }

  private processEmptyTile(band: Band, tile: Tile, mvScale: number): number {
    const mb = tile.mbs, ref = tile.ref, mbSize = band.mbSize, pitch = band.pitch, hp = band.isHalfpel;
    const clearFirst = !band.qdeltaPresent && !band.plane && !band.bandNum;
    if (tile.numMBs !== mbsPerTile(tile.width, tile.height, mbSize)) return ERR;

    let offs = tile.ypos * pitch + tile.xpos, needMc = false, n = 0;
    for (let y = tile.ypos; y < tile.ypos + tile.height; y += mbSize) {
      let mbOffset = offs;
      for (let x = tile.xpos; x < tile.xpos + tile.width; x += mbSize, n++) {
        mb.xpos[n] = x;
        mb.ypos[n] = y;
        mb.bufOffs[n] = mbOffset;
        mb.type[n] = 1;
        mb.cbp[n] = 0;
        if (clearFirst) {
          mb.qDelta[n] = band.globQuant;
          mb.mvX[n] = mb.mvY[n] = 0;
        }
        if (ref) {
          if (band.inheritQdelta) mb.qDelta[n] = ref.qDelta[n];
          if (band.inheritMv) {
            mb.mvX[n] = mvScale ? scaleMv(ref.mvX[n], mvScale) : ref.mvX[n];
            mb.mvY[n] = mvScale ? scaleMv(ref.mvY[n], mvScale) : ref.mvY[n];
            needMc ||= mb.mvX[n] !== 0 || mb.mvY[n] !== 0;
            const dmvX = mb.mvX[n] >> hp, dmvY = mb.mvY[n] >> hp, cx = mb.mvX[n] & hp, cy = mb.mvY[n] & hp;
            if (x + dmvX < 0 || x + dmvX + mbSize + cx > pitch || y + dmvY < 0 || y + dmvY + mbSize + cy > band.aheight) return ERR;
          }
        }
        mbOffset += mbSize;
      }
      offs += mbSize * pitch;
    }

    const buf = band.buf!, refBuf = band.refBuf!;
    if (band.inheritMv && needMc) {
      const blkSize = band.blkSize, numBlocks = mbSize !== blkSize ? 4 : 1;
      for (let i = 0; i < tile.numMBs; i++) {
        let mvX = mb.mvX[i], mvY = mb.mvY[i], mcType = 0;
        if (hp) {
          mcType = ((mvY & 1) << 1) | (mvX & 1);
          mvX >>= 1;
          mvY >>= 1;
        }
        for (let blk = 0; blk < numBlocks; blk++) {
          const o = mb.bufOffs[i] + blkSize * ((blk & 1) + (blk & 2 ? pitch : 0));
          mcPut(buf, o, refBuf, o + mvY * pitch + mvX, pitch, mcType, blkSize);
        }
      }
    } else {
      for (let y = 0, o = tile.ypos * pitch + tile.xpos; y < tile.height; y++, o += pitch) buf.set(refBuf.subarray(o, o + tile.width), o);
    }
    return 0;
  }
}
