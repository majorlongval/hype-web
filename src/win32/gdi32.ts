import type { Machine, Args } from "./machine";
import type { HleGen } from "./thread";
import { u32 } from "./user32";

interface GdiObj {
  type: number;
  data: Record<string, number>;
}

class GdiState {
  objs = new Map<number, GdiObj>();
  next = 0x2000;
  dcs = new Map<number, { hwnd: number; sel: Record<number, number>; bk: number; text: number; mode: number; saved: number }>();
  add(type: number, data: Record<string, number> = {}): number {
    const h = this.next;
    this.next += 4;
    this.objs.set(h, { type, data });
    return h;
  }
}

function g(m: Machine): GdiState {
  return (m.sub.gdi ??= new GdiState());
}

const OBJ_PEN = 1, OBJ_BRUSH = 2, OBJ_DC = 3, OBJ_PAL = 5, OBJ_FONT = 6, OBJ_BITMAP = 7, OBJ_REGION = 8, OBJ_MEMDC = 10;

export function registerGdi32(m0: Machine): void {
  const s0 = g(m0);
  const stock: number[] = [];
  for (let i = 0; i <= 19; i++) {
    const type = i <= 5 ? OBJ_BRUSH : i <= 8 ? OBJ_PEN : i === 15 ? OBJ_PAL : OBJ_FONT;
    stock[i] = s0.add(type, { stock: i });
  }
  const newDC = (m: Machine, hwnd: number, type = OBJ_DC) => {
    const s = g(m);
    const h = s.add(type, { hwnd });
    s.dcs.set(h, { hwnd, sel: { [OBJ_BRUSH]: stock[0], [OBJ_PEN]: stock[7], [OBJ_FONT]: stock[13] }, bk: 0xffffff, text: 0, mode: 2, saved: 0 });
    return h;
  };
  m0.sub.gdiGetDC = (hwnd: number) => newDC(m0, hwnd);

  const caps = (m: Machine, idx: number): number => {
    const s = u32(m);
    const t: Record<number, number> = { 0: 0x400, 2: 0, 4: 320, 6: 240, 8: s.screenW, 10: s.screenH, 12: 16, 14: 1, 24: -1, 26: 0,
      38: 0x7e99, 40: 0, 88: 96, 90: 96, 104: 0, 106: 0, 108: 16, 116: 60, 118: s.screenW, 117: s.screenH, 2048: 0 };
    return t[idx] ?? 0;
  };

  const ok = (n: number): [number, (m: Machine, a: Args) => number | void | HleGen] => [n, () => 1];
  const zero = (n: number): [number, (m: Machine, a: Args) => number | void | HleGen] => [n, () => 0];

  m0.register("gdi32.dll", {
    GetDeviceCaps: [8, (m, a) => caps(m, a.u(1))],
    GetStockObject: [4, (m, a) => stock[a.u(0)] ?? 0],
    CreateCompatibleDC: [4, (m) => newDC(m, 0, OBJ_MEMDC)],
    CreateDCA: [16, (m) => newDC(m, 0)],
    CreateICA: [16, (m) => newDC(m, 0)],
    DeleteDC: [4, (m, a) => { g(m).dcs.delete(a.u(0)); g(m).objs.delete(a.u(0)); return 1; }],
    SelectObject: [8, (m, a) => {
      const s = g(m);
      const dc = s.dcs.get(a.u(0)), o = s.objs.get(a.u(1));
      if (!dc || !o) return 0;
      if (o.type === OBJ_REGION) return 2;
      const old = dc.sel[o.type] ?? stock[0];
      dc.sel[o.type] = a.u(1);
      return old;
    }],
    GetCurrentObject: [8, (m, a) => g(m).dcs.get(a.u(0))?.sel[a.u(1)] ?? 0],
    GetObjectType: [4, (m, a) => g(m).objs.get(a.u(0))?.type ?? 0],
    DeleteObject: [4, (m, a) => { const o = g(m).objs.get(a.u(0)); if (o && o.data.stock === undefined) g(m).objs.delete(a.u(0)); return 1; }],
    GetObjectA: [12, (m, a) => {
      const o = g(m).objs.get(a.u(0));
      if (!o || !a.u(2)) return o ? 24 : 0;
      m.mem.fill(a.u(2), a.u(1), 0);
      if (o.type === OBJ_BITMAP) {
        const dv = m.mem.dv, p = a.u(2);
        dv.setInt32(p + 4, o.data.w ?? 1, true);
        dv.setInt32(p + 8, o.data.h ?? 1, true);
        dv.setInt32(p + 12, ((o.data.w ?? 1) * 2 + 3) & ~3, true);
        dv.setUint16(p + 16, 1, true);
        dv.setUint16(p + 18, o.data.bpp ?? 16, true);
      } else if (o.type === OBJ_FONT && a.u(1) >= 4) {
        m.mem.dv.setInt32(a.u(2), -12, true);
      }
      return a.u(1);
    }],
    CreateFontA: [56, (m) => g(m).add(OBJ_FONT)],
    CreateFontIndirectA: [4, (m) => g(m).add(OBJ_FONT)],
    CreateSolidBrush: [4, (m, a) => g(m).add(OBJ_BRUSH, { color: a.u(0) })],
    CreateBrushIndirect: [4, (m) => g(m).add(OBJ_BRUSH)],
    CreatePatternBrush: [4, (m) => g(m).add(OBJ_BRUSH)],
    CreateHatchBrush: [8, (m) => g(m).add(OBJ_BRUSH)],
    CreateDIBPatternBrushPt: [8, (m) => g(m).add(OBJ_BRUSH)],
    CreatePen: [12, (m) => g(m).add(OBJ_PEN)],
    CreatePenIndirect: [4, (m) => g(m).add(OBJ_PEN)],
    ExtCreatePen: [20, (m) => g(m).add(OBJ_PEN)],
    CreateCompatibleBitmap: [12, (m, a) => g(m).add(OBJ_BITMAP, { w: a.i(1), h: a.i(2), bpp: 16 })],
    CreateBitmap: [20, (m, a) => g(m).add(OBJ_BITMAP, { w: a.i(0), h: a.i(1), bpp: a.u(3) })],
    CreateBitmapIndirect: [4, (m) => g(m).add(OBJ_BITMAP, { w: 1, h: 1, bpp: 16 })],
    CreateDIBitmap: [24, (m) => g(m).add(OBJ_BITMAP, { w: 1, h: 1, bpp: 16 })],
    CreateDIBSection: [24, (m, a) => {
      const bi = a.u(1), dv = m.mem.dv;
      const w = dv.getInt32(bi + 4, true), h = Math.abs(dv.getInt32(bi + 8, true)), bpp = dv.getUint16(bi + 14, true);
      const bytes = (((w * bpp + 31) >> 5) << 2) * h;
      const p = m.processHeap.alloc(bytes, true);
      if (a.u(3)) dv.setUint32(a.u(3), p, true);
      return g(m).add(OBJ_BITMAP, { w, h, bpp, bits: p });
    }],
    CreatePalette: [4, (m) => g(m).add(OBJ_PAL)],
    SelectPalette: [12, () => 0],
    RealizePalette: [4, () => 0],
    GetPaletteEntries: [16, () => 0],
    SetPaletteEntries: [16, (m, a) => a.u(2)],
    GetSystemPaletteEntries: [16, () => 0],
    GetNearestColor: [8, (m, a) => a.u(1)],
    CreateRectRgn: [16, (m) => g(m).add(OBJ_REGION)],
    CreateRectRgnIndirect: [4, (m) => g(m).add(OBJ_REGION)],
    CreateEllipticRgn: [16, (m) => g(m).add(OBJ_REGION)],
    CombineRgn: [16, () => 2],
    SetRectRgn: [20, () => 1],
    OffsetRgn: [12, () => 2],
    GetRgnBox: [8, () => 2],
    SelectClipRgn: [8, () => 2],
    ExtSelectClipRgn: [12, () => 2],
    GetClipRgn: [8, () => 0],
    GetClipBox: [8, (m, a) => {
      const s = u32(m);
      const dv = m.mem.dv, p = a.u(1);
      dv.setInt32(p, 0, true); dv.setInt32(p + 4, 0, true); dv.setInt32(p + 8, s.screenW, true); dv.setInt32(p + 12, s.screenH, true);
      return 2;
    }],
    IntersectClipRect: [20, () => 2],
    ExcludeClipRect: [20, () => 2],
    OffsetClipRgn: [12, () => 2],
    PtVisible: [12, () => 1],
    RectVisible: [8, () => 1],
    SaveDC: [4, (m, a) => { const dc = g(m).dcs.get(a.u(0)); return dc ? ++dc.saved : 0; }],
    RestoreDC: [8, () => 1],
    SetBkColor: [8, (m, a) => { const dc = g(m).dcs.get(a.u(0)); const o = dc?.bk ?? 0; if (dc) dc.bk = a.u(1); return o; }],
    GetBkColor: [4, (m, a) => g(m).dcs.get(a.u(0))?.bk ?? 0xffffff],
    SetTextColor: [8, (m, a) => { const dc = g(m).dcs.get(a.u(0)); const o = dc?.text ?? 0; if (dc) dc.text = a.u(1); return o; }],
    GetTextColor: [4, (m, a) => g(m).dcs.get(a.u(0))?.text ?? 0],
    SetBkMode: [8, (m, a) => { const dc = g(m).dcs.get(a.u(0)); const o = dc?.mode ?? 2; if (dc) dc.mode = a.u(1); return o; }],
    GetBkMode: [4, (m, a) => g(m).dcs.get(a.u(0))?.mode ?? 2],
    SetMapMode: [8, () => 1],
    GetMapMode: [4, () => 1],
    SetROP2: [8, () => 13],
    SetStretchBltMode: [8, () => 1],
    GetStretchBltMode: [4, () => 1],
    SetPolyFillMode: [8, () => 1],
    SetTextAlign: [8, () => 0],
    SetTextJustification: [12, () => 1],
    SetTextCharacterExtra: [8, () => 0],
    SetMapperFlags: [8, () => 0],
    SetArcDirection: [8, () => 1],
    SetBrushOrgEx: [16, () => 1],
    SetViewportOrgEx: [16, () => 1],
    SetViewportExtEx: [16, () => 1],
    SetWindowOrgEx: [16, () => 1],
    SetWindowExtEx: [16, () => 1],
    OffsetViewportOrgEx: [16, () => 1],
    OffsetWindowOrgEx: [16, () => 1],
    ScaleViewportExtEx: [24, () => 1],
    ScaleWindowExtEx: [24, () => 1],
    GetViewportOrgEx: [8, (m, a) => { m.mem.fill(a.u(1), 8, 0); return 1; }],
    GetWindowOrgEx: [8, (m, a) => { m.mem.fill(a.u(1), 8, 0); return 1; }],
    GetViewportExtEx: [8, (m, a) => { m.mem.dv.setInt32(a.u(1), 1, true); m.mem.dv.setInt32(a.u(1) + 4, 1, true); return 1; }],
    GetWindowExtEx: [8, (m, a) => { m.mem.dv.setInt32(a.u(1), 1, true); m.mem.dv.setInt32(a.u(1) + 4, 1, true); return 1; }],
    LPtoDP: [12, () => 1],
    DPtoLP: [12, () => 1],
    GetTextMetricsA: [8, (m, a) => {
      const p = a.u(1), dv = m.mem.dv;
      m.mem.fill(p, 56, 0);
      [16, 13, 3, 0, 0, 7, 14, 400, 0, 96, 96].forEach((v, i) => dv.setInt32(p + i * 4, v, true));
      m.mem.u8[p + 45] = 32;
      m.mem.u8[p + 46] = 126;
      m.mem.u8[p + 47] = 32;
      m.mem.u8[p + 48] = 32;
      m.mem.u8[p + 52] = 0;
      return 1;
    }],
    GetTextExtentPoint32A: [16, (m, a) => { m.mem.dv.setInt32(a.u(3), a.i(2) * 7, true); m.mem.dv.setInt32(a.u(3) + 4, 16, true); return 1; }],
    GetTextExtentPointA: [16, (m, a) => { m.mem.dv.setInt32(a.u(3), a.i(2) * 7, true); m.mem.dv.setInt32(a.u(3) + 4, 16, true); return 1; }],
    GetTextFaceA: [12, (m, a) => { m.mem.writeCString(a.u(2), "MS Sans Serif"); return 13; }],
    GetCharWidthA: [16, (m, a) => { for (let i = 0; i <= a.u(2) - a.u(1); i++) m.mem.dv.setInt32(a.u(3) + i * 4, 7, true); return 1; }],
    EnumFontFamiliesA: zero(16),
    EnumFontsA: zero(16),
    TextOutA: ok(20),
    ExtTextOutA: ok(32),
    BitBlt: ok(36),
    StretchBlt: ok(44),
    PatBlt: ok(24),
    StretchDIBits: [52, (m, a) => a.i(8)],
    SetDIBitsToDevice: [48, (m, a) => a.u(7)],
    GetDIBits: [28, (m, a) => a.u(3)],
    SetDIBits: [28, (m, a) => a.u(3)],
    GetBitmapBits: zero(12),
    SetBitmapBits: [12, (m, a) => a.u(1)],
    Rectangle: ok(20),
    Ellipse: ok(20),
    RoundRect: ok(28),
    Polygon: ok(12),
    Polyline: ok(12),
    PolylineTo: ok(12),
    PolyBezierTo: ok(12),
    PolyDraw: ok(16),
    ArcTo: ok(36),
    MoveToEx: ok(16),
    LineTo: ok(12),
    GetPixel: zero(12),
    SetPixel: [16, (m, a) => a.u(3)],
    SetPixelV: ok(16),
    FillRgn: ok(12),
    FrameRgn: ok(20),
    InvertRgn: ok(8),
    PaintRgn: ok(8),
    Escape: zero(20),
    ExtEscape: zero(24),
    StartDocA: zero(8),
    EndDoc: zero(4),
    StartPage: zero(4),
    EndPage: zero(4),
    AbortDoc: zero(4),
    SetAbortProc: zero(8),
    CreateMetaFileA: zero(4),
    CloseMetaFile: zero(4),
    CopyMetaFileA: zero(8),
    DeleteMetaFile: ok(4),
    PlayMetaFile: ok(8),
    EnumMetaFile: ok(16),
    PlayMetaFileRecord: ok(16),
    SelectClipPath: ok(8),
    SetColorAdjustment: ok(8),
    GdiFlush: ok(0),
    UnrealizeObject: ok(4),
  });
}
