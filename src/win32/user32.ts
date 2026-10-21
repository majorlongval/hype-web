import { Machine, Args, hex } from "./machine";
import type { HleGen } from "./thread";
import { Thread } from "./thread";
import { putA, setError, cp1252 } from "./kernel32";
import { loadString } from "./resources";
import { formatPrintf } from "./printf";
import { waitFor } from "./machine";
import { KObject } from "./objects";

export const WM_CREATE = 0x1, WM_DESTROY = 0x2, WM_MOVE = 0x3, WM_SIZE = 0x5, WM_ACTIVATE = 0x6, WM_SETFOCUS = 0x7;
export const WM_KILLFOCUS = 0x8, WM_SETTEXT = 0xc, WM_GETTEXT = 0xd, WM_GETTEXTLENGTH = 0xe, WM_PAINT = 0xf;
export const WM_CLOSE = 0x10, WM_QUIT = 0x12, WM_ERASEBKGND = 0x14, WM_SHOWWINDOW = 0x18, WM_ACTIVATEAPP = 0x1c;
export const WM_SETCURSOR = 0x20, WM_GETMINMAXINFO = 0x24, WM_WINDOWPOSCHANGING = 0x46, WM_WINDOWPOSCHANGED = 0x47;
export const WM_NCCREATE = 0x81, WM_NCDESTROY = 0x82, WM_NCCALCSIZE = 0x83, WM_NCHITTEST = 0x84, WM_NCACTIVATE = 0x86;
export const WM_KEYDOWN = 0x100, WM_KEYUP = 0x101, WM_CHAR = 0x102, WM_SYSKEYDOWN = 0x104, WM_SYSKEYUP = 0x105;
export const WM_SYSCHAR = 0x106, WM_COMMAND = 0x111, WM_SYSCOMMAND = 0x112, WM_TIMER = 0x113;
export const WM_MOUSEMOVE = 0x200, WM_LBUTTONDOWN = 0x201, WM_LBUTTONUP = 0x202, WM_RBUTTONDOWN = 0x204, WM_RBUTTONUP = 0x205;
export const WM_USER = 0x400;

export interface Rect { l: number; t: number; r: number; b: number }

export class WndClass {
  constructor(
    public name: string,
    public atom: number,
    public style: number,
    public proc: number,
    public clsExtra: number,
    public wndExtra: number,
    public hInstance: number,
    public hIcon: number,
    public hCursor: number,
    public hbrBackground: number,
    public menuName: number,
  ) {}
  extra = new Int32Array(64);
}

export class Wnd {
  extra: Int32Array;
  props = new Map<string, number>();
  userData = 0;
  visible = false;
  enabled = true;
  destroyed = false;
  text = "";
  menu = 0;
  id = 0;
  invalid = false;
  constructor(
    public hwnd: number,
    public cls: WndClass,
    public proc: number,
    public style: number,
    public exStyle: number,
    public parent: number,
    public rect: Rect,
    public thread: Thread,
    public hInstance: number,
  ) {
    this.extra = new Int32Array(Math.ceil(Math.max(cls.wndExtra, 4) / 4) + 1);
  }
}

interface Hook { id: number; type: number; proc: number; thread: number }
interface Timer { hwnd: number; id: number; interval: number; next: number; proc: number; thread: Thread }

export class User32State {
  classes = new Map<string, WndClass>();
  windows = new Map<number, Wnd>();
  nextHwnd = 0x10010;
  nextAtom = 0xc100;
  hooks: Hook[] = [];
  nextHook = 0x7000;
  timers: Timer[] = [];
  focus = 0;
  active = 0;
  capture = 0;
  cursorShow = 0;
  cursorPos = { x: 320, y: 240 };
  keyState = new Uint8Array(256);
  screenW = 1024;
  screenH = 768;
  messages = new Map<string, number>();
  nextMsg = 0xc000;
  desktop = 0;
  lastMsgPos = 0;
  lastMsgTime = 0;
}

export function u32(m: Machine): User32State {
  return (m.sub.user32 ??= new User32State());
}

function wnd(m: Machine, h: number): Wnd | undefined {
  return u32(m).windows.get(h >>> 0);
}

function writeRect(m: Machine, p: number, r: Rect): void {
  const dv = m.mem.dv;
  dv.setInt32(p, r.l, true);
  dv.setInt32(p + 4, r.t, true);
  dv.setInt32(p + 8, r.r, true);
  dv.setInt32(p + 12, r.b, true);
}
function readRect(m: Machine, p: number): Rect {
  const dv = m.mem.dv;
  return { l: dv.getInt32(p, true), t: dv.getInt32(p + 4, true), r: dv.getInt32(p + 8, true), b: dv.getInt32(p + 12, true) };
}

/** Posts a message to the queue of the window's thread (or a thread directly if hwnd is 0). */
export function postMessage(m: Machine, t: Thread, hwnd: number, msg: number, wp: number, lp: number): void {
  const s = u32(m);
  t.queue.push([hwnd, msg, wp >>> 0, lp >>> 0, Math.floor(m.now()) >>> 0, s.cursorPos.x, s.cursorPos.y]);
}

/** Calls a window procedure (guest code) as a generator step. */
export function* sendMessage(m: Machine, hwnd: number, msg: number, wp: number, lp: number): HleGen {
  const w = wnd(m, hwnd);
  if (!w || w.destroyed) return 0;
  const r = yield { t: "call", addr: w.proc, args: [hwnd, msg, wp >>> 0, lp >>> 0] };
  return r;
}

function* callHooks(m: Machine, type: number, code: number, wp: number, lp: number): Generator<any, number, number> {
  const s = u32(m);
  const t = m.cur!;
  const hooks = s.hooks.filter((h) => h.type === type && (h.thread === 0 || h.thread === t.id));
  if (!hooks.length) return 0;
  m.sub.hookChain = hooks;
  m.sub.hookPos = 0;
  return yield { t: "call", addr: hooks[0].proc, args: [code, wp, lp] };
}

function matchMsg(e: number[], hwnd: number, min: number, max: number): boolean {
  if (hwnd && e[0] !== hwnd && hwnd !== 0xffffffff) return false;
  if (hwnd === 0xffffffff && e[0] !== 0) return false;
  if (min === 0 && max === 0) return true;
  return e[1] >= min && e[1] <= max;
}

function writeMsg(m: Machine, p: number, e: number[]): void {
  const dv = m.mem.dv;
  dv.setUint32(p, e[0], true);
  dv.setUint32(p + 4, e[1], true);
  dv.setUint32(p + 8, e[2], true);
  dv.setUint32(p + 12, e[3], true);
  dv.setUint32(p + 16, e[4], true);
  dv.setInt32(p + 20, e[5], true);
  dv.setInt32(p + 24, e[6], true);
  const s = u32(m);
  s.lastMsgTime = e[4];
  s.lastMsgPos = ((e[6] & 0xffff) << 16) | (e[5] & 0xffff);
}

/** Moves due timers and pending paints into thread queues. */
function pumpSynthetic(m: Machine, t: Thread): void {
  const s = u32(m);
  const now = m.now();
  for (const tm of s.timers) {
    if (tm.thread === t && now >= tm.next) {
      tm.next = now + Math.max(tm.interval, 10);
      if (!t.queue.some((e) => e[1] === WM_TIMER && e[0] === tm.hwnd && e[2] === tm.id)) {
        postMessage(m, t, tm.hwnd, WM_TIMER, tm.id, tm.proc);
      }
    }
  }
  for (const w of s.windows.values()) {
    if (w.invalid && w.thread === t && !w.destroyed && isShown(s, w)) {
      w.invalid = false;
      if (!t.queue.some((e) => e[1] === WM_PAINT && e[0] === w.hwnd)) postMessage(m, t, w.hwnd, WM_PAINT, 0, 0);
    }
  }
}

function isShown(s: User32State, w: Wnd): boolean {
  for (let p: Wnd | undefined = w; p; p = s.windows.get(p.parent)) if (!p.visible) return false;
  return true;
}

function invalidateTree(s: User32State, w: Wnd): void {
  w.invalid = true;
  for (const c of s.windows.values()) if (c.parent === w.hwnd && c.visible) invalidateTree(s, c);
}

function takeMsg(m: Machine, t: Thread, hwnd: number, min: number, max: number, remove: boolean): number[] | null {
  pumpSynthetic(m, t);
  for (let i = 0; i < t.queue.length; i++) {
    const e = t.queue[i];
    if (matchMsg(e, hwnd, min, max)) {
      if (remove) t.queue.splice(i, 1);
      return e;
    }
  }
  return null;
}

export function installUser32Input(m: Machine): void {
  m.hasInput = (t) => {
    pumpSynthetic(m, t);
    return t.queue.length > 0 || t.quitPosted;
  };
}

// ---------- keyboard ----------

const VK_TO_SCAN: Record<number, number> = {
  0x1b: 1, 0x31: 2, 0x32: 3, 0x33: 4, 0x34: 5, 0x35: 6, 0x36: 7, 0x37: 8, 0x38: 9, 0x39: 10, 0x30: 11, 0xbd: 12, 0xbb: 13,
  0x08: 14, 0x09: 15, 0x51: 16, 0x57: 17, 0x45: 18, 0x52: 19, 0x54: 20, 0x59: 21, 0x55: 22, 0x49: 23, 0x4f: 24, 0x50: 25,
  0xdb: 26, 0xdd: 27, 0x0d: 28, 0x11: 29, 0x41: 30, 0x53: 31, 0x44: 32, 0x46: 33, 0x47: 34, 0x48: 35, 0x4a: 36, 0x4b: 37,
  0x4c: 38, 0xba: 39, 0xde: 40, 0xc0: 41, 0x10: 42, 0xdc: 43, 0x5a: 44, 0x58: 45, 0x43: 46, 0x56: 47, 0x42: 48, 0x4e: 49,
  0x4d: 50, 0xbc: 51, 0xbe: 52, 0xbf: 53, 0xa1: 54, 0x6a: 55, 0x12: 56, 0x20: 57, 0x14: 58, 0x70: 59, 0x71: 60, 0x72: 61,
  0x73: 62, 0x74: 63, 0x75: 64, 0x76: 65, 0x77: 66, 0x78: 67, 0x79: 68, 0x90: 69, 0x91: 70, 0x24: 71, 0x26: 72, 0x21: 73,
  0x6d: 74, 0x25: 75, 0x0c: 76, 0x27: 77, 0x6b: 78, 0x23: 79, 0x28: 80, 0x22: 81, 0x2d: 82, 0x2e: 83, 0x7a: 87, 0x7b: 88,
  0xa0: 42, 0xa2: 29, 0xa3: 29, 0xa4: 56, 0xa5: 56, 0x60: 82, 0x61: 79, 0x62: 80, 0x63: 81, 0x64: 75, 0x65: 76, 0x66: 77,
  0x67: 71, 0x68: 72, 0x69: 73, 0x6e: 83, 0x6f: 53, 0x13: 69,
};
const SCAN_TO_VK: Record<number, number> = {};
for (const [vk, sc] of Object.entries(VK_TO_SCAN)) if (!(sc in SCAN_TO_VK) || Number(vk) < 0xa0) SCAN_TO_VK[sc] ??= Number(vk);
export { VK_TO_SCAN };

function vkToChar(vk: number, shift: boolean): number {
  if (vk >= 0x41 && vk <= 0x5a) return shift ? vk : vk + 32;
  if (vk >= 0x30 && vk <= 0x39) return shift ? ")!@#$%^&*(".charCodeAt(vk - 0x30) : vk;
  const map: Record<number, [string, string]> = {
    0x20: [" ", " "], 0x0d: ["\r", "\r"], 0x08: ["\b", "\b"], 0x09: ["\t", "\t"], 0x1b: ["\x1b", "\x1b"],
    0xbd: ["-", "_"], 0xbb: ["=", "+"], 0xdb: ["[", "{"], 0xdd: ["]", "}"], 0xba: [";", ":"], 0xde: ["'", '"'],
    0xc0: ["`", "~"], 0xdc: ["\\", "|"], 0xbc: [",", "<"], 0xbe: [".", ">"], 0xbf: ["/", "?"],
    0x6a: ["*", "*"], 0x6b: ["+", "+"], 0x6d: ["-", "-"], 0x6e: [".", "."], 0x6f: ["/", "/"],
  };
  if (vk >= 0x60 && vk <= 0x69) return 0x30 + vk - 0x60;
  const e = map[vk];
  return e ? e[shift ? 1 : 0].charCodeAt(0) : 0;
}

/** Host keyboard input: updates key state and posts WM_KEYDOWN/UP/CHAR to the focus window. */
export function injectKey(m: Machine, vk: number, down: boolean): void {
  const s = u32(m);
  const was = (s.keyState[vk] & 0x80) !== 0;
  if (down) s.keyState[vk] = (s.keyState[vk] | 0x80) ^ (was ? 0 : 1);
  else s.keyState[vk] &= ~0x80;
  if (vk === 0xa0 || vk === 0xa1) s.keyState[0x10] = down ? s.keyState[0x10] | 0x80 : s.keyState[0x10] & ~0x80;
  if (vk === 0xa2 || vk === 0xa3) s.keyState[0x11] = down ? s.keyState[0x11] | 0x80 : s.keyState[0x11] & ~0x80;
  if (vk === 0xa4 || vk === 0xa5) s.keyState[0x12] = down ? s.keyState[0x12] | 0x80 : s.keyState[0x12] & ~0x80;
  const target = wnd(m, s.focus) ?? wnd(m, s.active) ?? [...s.windows.values()].find((w) => w.visible && !w.parent);
  if (!target) return;
  const scan = VK_TO_SCAN[vk] ?? 0;
  const alt = (s.keyState[0x12] & 0x80) !== 0;
  const lp = (1 | (scan << 16) | (down ? (was ? 0x40000000 : 0) : 0xc0000000) | (alt ? 0x20000000 : 0)) >>> 0;
  const msg = alt || vk === 0x12 ? (down ? WM_SYSKEYDOWN : WM_SYSKEYUP) : down ? WM_KEYDOWN : WM_KEYUP;
  postMessage(m, target.thread, target.hwnd, msg, vk, lp);
}

// ---------- window creation ----------

function* createWindow(m: Machine, a: Args): HleGen {
  const s = u32(m);
  const ex = a.u(0), clsPtr = a.u(1), namePtr = a.u(2), style = a.u(3);
  let x = a.i(4), y = a.i(5), w = a.i(6), h = a.i(7);
  const parent = a.u(8), menu = a.u(9), inst = a.u(10), param = a.u(11);
  const clsName = clsPtr < 0x10000 ? [...s.classes.values()].find((c) => c.atom === clsPtr)?.name : m.mem.readCString(clsPtr).toUpperCase();
  const cls = clsName ? s.classes.get(clsName) : undefined;
  if (!cls) {
    m.log(`CreateWindowEx: unknown class ${clsPtr < 0x10000 ? hex(clsPtr) : m.mem.readCString(clsPtr)}`);
    setError(m, 1407);
    return 0;
  }
  if (x === -0x80000000) { x = 0; y = 0; }
  if (w === -0x80000000) { w = s.screenW; h = s.screenH; }
  let px = 0, py = 0;
  const pw = wnd(m, parent);
  if (pw && style & 0x40000000) { px = pw.rect.l; py = pw.rect.t; }
  const hwnd = s.nextHwnd;
  s.nextHwnd += 4;
  const win = new Wnd(hwnd, cls, cls.proc, style, ex, parent, { l: x + px, t: y + py, r: x + px + w, b: y + py + h }, m.cur!, inst);
  win.text = namePtr ? m.mem.readCString(namePtr) : "";
  if (style & 0x40000000) win.id = menu;
  else win.menu = menu;
  s.windows.set(hwnd, win);

  const cs = m.processHeap.alloc(48, true);
  const dv = m.mem.dv;
  dv.setUint32(cs, param, true);
  dv.setUint32(cs + 4, inst, true);
  dv.setUint32(cs + 8, menu, true);
  dv.setUint32(cs + 12, parent, true);
  dv.setInt32(cs + 16, h, true);
  dv.setInt32(cs + 20, w, true);
  dv.setInt32(cs + 24, y, true);
  dv.setInt32(cs + 28, x, true);
  dv.setUint32(cs + 32, style, true);
  dv.setUint32(cs + 36, namePtr, true);
  dv.setUint32(cs + 40, clsPtr, true);
  dv.setUint32(cs + 44, ex, true);

  const cbt = m.processHeap.alloc(8, true);
  dv.setUint32(cbt, cs, true);
  const hookR = yield* callHooks(m, 5, 3, hwnd, cbt);
  m.processHeap.free(cbt);
  if (hookR) {
    s.windows.delete(hwnd);
    return 0;
  }
  const mmi = m.processHeap.alloc(40, true);
  yield* sendMessage(m, hwnd, WM_GETMINMAXINFO, 0, mmi);
  m.processHeap.free(mmi);
  const ok = yield* sendMessage(m, hwnd, WM_NCCREATE, 0, cs);
  if (!ok) {
    m.log(`WM_NCCREATE refused for ${cls.name}`);
    s.windows.delete(hwnd);
    m.processHeap.free(cs);
    return 0;
  }
  const r = yield* sendMessage(m, hwnd, WM_CREATE, 0, cs);
  m.processHeap.free(cs);
  if ((r as number) === 0xffffffff) {
    s.windows.delete(hwnd);
    return 0;
  }
  yield* sendMessage(m, hwnd, WM_SIZE, 0, ((h & 0xffff) << 16) | (w & 0xffff));
  yield* sendMessage(m, hwnd, WM_MOVE, 0, ((y & 0xffff) << 16) | (x & 0xffff));
  if (style & 0x10000000) {
    win.visible = true;
    win.invalid = true;
    yield* sendMessage(m, hwnd, WM_SHOWWINDOW, 1, 0);
    if (!(style & 0x40000000)) yield* activate(m, hwnd);
  }
  return hwnd;
}

function* setWindowPos(m: Machine, hwnd: number, x: number, y: number, cx: number, cy: number, flags: number): HleGen {
  const w = u32(m).windows.get(hwnd);
  if (!w) return 0;
  if (!(flags & 2)) { const wd = w.rect.r - w.rect.l, ht = w.rect.b - w.rect.t; w.rect = { l: x, t: y, r: x + wd, b: y + ht }; }
  if (!(flags & 1)) { w.rect.r = w.rect.l + cx; w.rect.b = w.rect.t + cy; }
  if (flags & 0x40) { w.visible = true; invalidateTree(u32(m), w); }
  if (flags & 0x80) w.visible = false;
  if (!(flags & 1) && !(flags & 8)) invalidateTree(u32(m), w);
  if (!(flags & 1)) yield* sendMessage(m, w.hwnd, WM_SIZE, 0, (((w.rect.b - w.rect.t) & 0xffff) << 16) | ((w.rect.r - w.rect.l) & 0xffff));
  return 1;
}

function* activate(m: Machine, hwnd: number): HleGen {
  const s = u32(m);
  if (s.active === hwnd) return 0;
  const old = s.active;
  s.active = hwnd;
  if (!old) yield* sendMessage(m, hwnd, WM_ACTIVATEAPP, 1, 0);
  yield* sendMessage(m, hwnd, WM_NCACTIVATE, 1, 0);
  yield* sendMessage(m, hwnd, WM_ACTIVATE, 1, old);
  if (!s.focus || s.focus === old) {
    s.focus = hwnd;
    yield* sendMessage(m, hwnd, WM_SETFOCUS, old, 0);
  }
  return 0;
}

function* destroyWindow(m: Machine, hwnd: number): HleGen {
  const s = u32(m);
  const w = wnd(m, hwnd);
  if (!w || w.destroyed) return 0;
  for (const c of [...s.windows.values()]) if (c.parent === hwnd && !c.destroyed) yield* destroyWindow(m, c.hwnd);
  yield* sendMessage(m, hwnd, WM_DESTROY, 0, 0);
  yield* sendMessage(m, hwnd, WM_NCDESTROY, 0, 0);
  w.destroyed = true;
  s.windows.delete(hwnd);
  s.timers = s.timers.filter((t) => t.hwnd !== hwnd);
  if (s.focus === hwnd) s.focus = 0;
  if (s.active === hwnd) s.active = 0;
  return 1;
}

function* defWindowProc(m: Machine, hwnd: number, msg: number, wp: number, lp: number): HleGen {
  const w = wnd(m, hwnd);
  switch (msg) {
    case WM_NCCREATE: {
      if (w && lp) {
        const name = m.mem.dv.getUint32(lp + 36, true);
        if (name) w.text = m.mem.readCString(name);
      }
      return 1;
    }
    case WM_CLOSE:
      yield* destroyWindow(m, hwnd);
      return 0;
    case WM_SETTEXT:
      if (w) w.text = lp ? m.mem.readCString(lp) : "";
      return 1;
    case WM_GETTEXT:
      return w ? putA(m, lp, wp, w.text) : 0;
    case WM_GETTEXTLENGTH:
      return w ? w.text.length : 0;
    case WM_ERASEBKGND:
      return 1;
    case WM_PAINT:
      if (w) w.invalid = false;
      return 0;
    case WM_NCHITTEST:
      return 1;
    case WM_NCACTIVATE:
      return 1;
    case WM_NCCALCSIZE:
      return 0;
    case WM_SETCURSOR:
      return 0;
    case WM_SYSCOMMAND:
      if ((wp & 0xfff0) === 0xf060) yield* sendMessage(m, hwnd, WM_CLOSE, 0, 0);
      return 0;
    case WM_SYSKEYDOWN:
      if (wp === 0x73 && lp & 0x20000000) yield* sendMessage(m, hwnd, WM_CLOSE, 0, 0);
      return 0;
    case WM_WINDOWPOSCHANGED:
      return 0;
    case 0x7b:
      return 0;
    default:
      return 0;
  }
}

function clientRect(w: Wnd): Rect {
  return { l: 0, t: 0, r: w.rect.r - w.rect.l, b: w.rect.b - w.rect.t };
}

// ---------- registration ----------

export function registerUser32(m0: Machine): void {
  const s0 = u32(m0);
  installUser32Input(m0);
  const defProc = m0.thunk("user32.dll", "DefWindowProcA");
  const builtin = (name: string) => {
    const c = new WndClass(name, s0.nextAtom++, 0, defProc, 0, 32, 0, 0, 0, 0, 0);
    s0.classes.set(name, c);
  };
  ["BUTTON", "EDIT", "STATIC", "LISTBOX", "COMBOBOX", "SCROLLBAR", "#32770", "MDICLIENT", "MCIWNDCLASS"].forEach(builtin);
  s0.desktop = s0.nextHwnd;
  s0.nextHwnd += 4;

  const regClass = (m: Machine, p: number, ex: boolean): number => {
    const dv = m.mem.dv;
    const o = ex ? 4 : 0;
    const style = dv.getUint32(p + o, true), proc = dv.getUint32(p + o + 4, true);
    const clsExtra = dv.getInt32(p + o + 8, true), wndExtra = dv.getInt32(p + o + 12, true);
    const inst = dv.getUint32(p + o + 16, true), icon = dv.getUint32(p + o + 20, true), cursor = dv.getUint32(p + o + 24, true);
    const brush = dv.getUint32(p + o + 28, true), menu = dv.getUint32(p + o + 32, true), namePtr = dv.getUint32(p + o + 36, true);
    const s = u32(m);
    const name = namePtr < 0x10000 ? `#${namePtr}` : m.mem.readCString(namePtr).toUpperCase();
    if (s.classes.has(name) && !["BUTTON", "EDIT", "STATIC", "#32770"].includes(name)) {
      setError(m, 1410);
      return 0;
    }
    const c = new WndClass(name, s.nextAtom++, style, proc, clsExtra, wndExtra, inst, icon, cursor, brush, menu);
    s.classes.set(name, c);
    return c.atom;
  };
  const classInfo = (m: Machine, a: Args, ex: boolean): number => {
    const s = u32(m);
    const p = a.u(1);
    const name = p < 0x10000 ? [...s.classes.values()].find((c) => c.atom === p)?.name : m.mem.readCString(p).toUpperCase();
    const c = name ? s.classes.get(name) : undefined;
    if (!c) { setError(m, 1411); return 0; }
    const q = a.u(2), dv = m.mem.dv, o = ex ? 4 : 0;
    if (ex) dv.setUint32(q, 48, true);
    [c.style, c.proc, c.clsExtra, c.wndExtra, c.hInstance || a.u(0), c.hIcon, c.hCursor, c.hbrBackground, c.menuName, p]
      .forEach((v, i) => dv.setUint32(q + o + i * 4, v >>> 0, true));
    return c.atom;
  };

  const u: Record<string, [number, (m: Machine, a: Args) => number | void | HleGen]> = {
    // The host browser owns system-wide shortcuts; guests cannot reserve them.
    RegisterHotKey: [16, (m) => { setError(m, 1409); return 0; }],
    UnregisterHotKey: [8, () => 0],
    RegisterClassA: [4, (m, a) => regClass(m, a.u(0), false)],
    RegisterClassExA: [4, (m, a) => regClass(m, a.u(0), true)],
    UnregisterClassA: [8, (m, a) => {
      const p = a.u(0);
      const s = u32(m);
      if (p < 0x10000) { for (const [k, c] of s.classes) if (c.atom === p) s.classes.delete(k); }
      else s.classes.delete(m.mem.readCString(p).toUpperCase());
      return 1;
    }],
    GetClassInfoA: [12, (m, a) => classInfo(m, a, false)],
    GetClassInfoExA: [12, (m, a) => classInfo(m, a, true)],
    GetClassNameA: [12, (m, a) => { const w = wnd(m, a.u(0)); return w ? putA(m, a.u(1), a.u(2), w.cls.name) : 0; }],
    GetClassLongA: [8, (m, a) => {
      const w = wnd(m, a.u(0));
      if (!w) return 0;
      switch (a.i(1)) {
        case -24: return w.cls.proc;
        case -26: return w.cls.style;
        case -10: return w.cls.hbrBackground;
        case -12: return w.cls.hCursor;
        case -14: return w.cls.hIcon;
        case -16: return w.cls.hInstance;
        case -32: return w.cls.atom;
        default: return a.i(1) >= 0 ? w.cls.extra[a.i(1) >> 2] : 0;
      }
    }],
    SetClassLongA: [12, (m, a) => {
      const w = wnd(m, a.u(0));
      if (!w) return 0;
      let old = 0;
      switch (a.i(1)) {
        case -24: old = w.cls.proc; w.cls.proc = a.u(2); break;
        case -12: old = w.cls.hCursor; w.cls.hCursor = a.u(2); break;
        case -14: old = w.cls.hIcon; w.cls.hIcon = a.u(2); break;
        case -10: old = w.cls.hbrBackground; w.cls.hbrBackground = a.u(2); break;
        default: if (a.i(1) >= 0) { old = w.cls.extra[a.i(1) >> 2]; w.cls.extra[a.i(1) >> 2] = a.u(2); }
      }
      return old;
    }],
    CreateWindowExA: [48, createWindow],
    DestroyWindow: [4, function* (m, a) { return yield* destroyWindow(m, a.u(0)); }],
    DefWindowProcA: [16, function* (m, a) { return yield* defWindowProc(m, a.u(0), a.u(1), a.u(2), a.u(3)); }],
    DefDlgProcA: [16, function* (m, a) { return yield* defWindowProc(m, a.u(0), a.u(1), a.u(2), a.u(3)); }],
    DefFrameProcA: [20, function* (m, a) { return yield* defWindowProc(m, a.u(0), a.u(2), a.u(3), a.u(4)); }],
    DefMDIChildProcA: [16, function* (m, a) { return yield* defWindowProc(m, a.u(0), a.u(1), a.u(2), a.u(3)); }],
    CallWindowProcA: [20, function* (m, a) {
      const proc = a.u(0);
      if (!proc) return 0;
      return yield { t: "call", addr: proc, args: [a.u(1), a.u(2), a.u(3), a.u(4)] };
    }],
    SendMessageA: [16, function* (m, a) {
      const hwnd = a.u(0);
      if (hwnd === 0xffff) {
        for (const w of [...u32(m).windows.values()]) if (!w.parent) yield* sendMessage(m, w.hwnd, a.u(1), a.u(2), a.u(3));
        return 0;
      }
      return yield* sendMessage(m, hwnd, a.u(1), a.u(2), a.u(3));
    }],
    PostMessageA: [16, (m, a) => {
      const hwnd = a.u(0);
      if (hwnd === 0xffff || hwnd === 0) {
        for (const w of u32(m).windows.values()) if (!w.parent) postMessage(m, w.thread, w.hwnd, a.u(1), a.u(2), a.u(3));
        if (hwnd === 0) postMessage(m, m.cur!, 0, a.u(1), a.u(2), a.u(3));
        return 1;
      }
      const w = wnd(m, hwnd);
      if (!w) { setError(m, 1400); return 0; }
      postMessage(m, w.thread, hwnd, a.u(1), a.u(2), a.u(3));
      return 1;
    }],
    PostThreadMessageA: [16, (m, a) => {
      const t = m.threads.find((x) => x.id === a.u(0));
      if (!t || t.state === "done") return 0;
      postMessage(m, t, 0, a.u(1), a.u(2), a.u(3));
      return 1;
    }],
    PostQuitMessage: [4, (m, a) => {
      m.cur!.quitPosted = true;
      m.sub.quitCode = a.u(0);
    }],
    GetMessageA: [16, function* (m, a) {
      const t = m.cur!;
      for (;;) {
        const e = takeMsg(m, t, a.u(1), a.u(2), a.u(3), true);
        if (e) {
          writeMsg(m, a.u(0), e);
          yield* callHooks(m, 3, 0, 1, a.u(0));
          return e[1] === WM_QUIT ? 0 : 1;
        }
        if (t.quitPosted) {
          t.quitPosted = false;
          writeMsg(m, a.u(0), [0, WM_QUIT, m.sub.quitCode ?? 0, 0, Math.floor(m.now()), 0, 0]);
          return 0;
        }
        yield* waitFor(m, [], false, nextTimerDelay(m, t), 0xff);
      }
    }],
    PeekMessageA: [20, function* (m, a) {
      const t = m.cur!;
      const remove = (a.u(4) & 1) !== 0;
      const e = takeMsg(m, t, a.u(1), a.u(2), a.u(3), remove);
      if (e) {
        writeMsg(m, a.u(0), e);
        if (remove) yield* callHooks(m, 3, 0, 1, a.u(0));
        return 1;
      }
      if (t.quitPosted) {
        if (remove) t.quitPosted = false;
        writeMsg(m, a.u(0), [0, WM_QUIT, m.sub.quitCode ?? 0, 0, Math.floor(m.now()), 0, 0]);
        return 1;
      }
      m.sub.peekIdle = (m.sub.peekIdle ?? 0) + 1;
      return 0;
    }],
    WaitMessage: [0, function* (m) {
      const t = m.cur!;
      if (t.queue.length) return 1;
      yield* waitFor(m, [], false, nextTimerDelay(m, t), 0xff);
      return 1;
    }],
    MsgWaitForMultipleObjects: [20, function* (m, a) {
      const objs: KObject[] = [];
      for (let i = 0; i < a.u(0); i++) {
        const o = m.handles.get(m.mem.dv.getUint32(a.u(1) + i * 4, true));
        if (o) objs.push(o);
      }
      const t = m.cur!;
      const i = objs.findIndex((o) => o.signaled(t));
      if (i >= 0) { objs[i].acquire(t); return i; }
      if (t.queue.length) return objs.length;
      if (a.u(3) === 0) return 0x102;
      return yield* waitFor(m, objs, a.u(2) !== 0, Math.min(a.u(3), nextTimerDelay(m, t)), a.u(4));
    }],
    GetQueueStatus: [4, (m) => (m.cur!.queue.length ? 0x00ff00ff : 0)],
    GetInputState: [0, (m) => (m.cur!.queue.length ? 1 : 0)],
    TranslateMessage: [4, (m, a) => {
      const dv = m.mem.dv, p = a.u(0);
      const msg = dv.getUint32(p + 4, true), vk = dv.getUint32(p + 8, true);
      if (msg !== WM_KEYDOWN && msg !== WM_SYSKEYDOWN) return 0;
      const s = u32(m);
      const ch = vkToChar(vk, (s.keyState[0x10] & 0x80) !== 0);
      if (!ch) return 0;
      m.cur!.queue.unshift([dv.getUint32(p, true), msg === WM_KEYDOWN ? WM_CHAR : WM_SYSCHAR, ch, dv.getUint32(p + 12, true),
        dv.getUint32(p + 16, true), 0, 0]);
      return 1;
    }],
    DispatchMessageA: [4, function* (m, a) {
      const dv = m.mem.dv, p = a.u(0);
      const hwnd = dv.getUint32(p, true), msg = dv.getUint32(p + 4, true), wp = dv.getUint32(p + 8, true), lp = dv.getUint32(p + 12, true);
      if (msg === WM_TIMER && lp) return yield { t: "call", addr: lp, args: [hwnd, msg, wp, Math.floor(m.now()) >>> 0] };
      if (!hwnd) return 0;
      return yield* sendMessage(m, hwnd, msg, wp, lp);
    }],
    IsDialogMessageA: [8, () => 0],
    TranslateAcceleratorA: [12, () => 0],
    TranslateMDISysAccel: [8, () => 0],
    InSendMessage: [0, () => 0],
    ReplyMessage: [4, () => 0],
    GetMessagePos: [0, (m) => u32(m).lastMsgPos],
    GetMessageTime: [0, (m) => u32(m).lastMsgTime],
    GetMessageExtraInfo: [0, () => 0],
    RegisterWindowMessageA: [4, (m, a) => {
      const s = u32(m), name = (a.str(0) ?? "").toUpperCase();
      let v = s.messages.get(name);
      if (!v) s.messages.set(name, (v = s.nextMsg++));
      return v;
    }],

    SetWindowsHookExA: [16, (m, a) => {
      const s = u32(m);
      const h: Hook = { id: s.nextHook++, type: a.i(0), proc: a.u(1), thread: a.u(3) };
      s.hooks.unshift(h);
      m.log(`SetWindowsHookEx type ${a.i(0)} proc ${m.symbolize(a.u(1))} thread ${a.u(3)}`);
      return h.id;
    }],
    SetWindowsHookA: [8, (m, a) => {
      const s = u32(m);
      const h: Hook = { id: s.nextHook++, type: a.i(0), proc: a.u(1), thread: m.cur!.id };
      s.hooks.unshift(h);
      return h.id;
    }],
    UnhookWindowsHookEx: [4, (m, a) => {
      const s = u32(m);
      s.hooks = s.hooks.filter((h) => h.id !== a.u(0));
      return 1;
    }],
    UnhookWindowsHook: [8, (m, a) => {
      const s = u32(m);
      s.hooks = s.hooks.filter((h) => h.proc !== a.u(1));
      return 1;
    }],
    CallNextHookEx: [16, function* (m, a) {
      const chain: Hook[] | undefined = m.sub.hookChain;
      const pos: number = m.sub.hookPos ?? 0;
      if (!chain || pos + 1 >= chain.length) return 0;
      m.sub.hookPos = pos + 1;
      return yield { t: "call", addr: chain[pos + 1].proc, args: [a.u(1), a.u(2), a.u(3)] };
    }],

    GetWindowLongA: [8, (m, a) => {
      const w = wnd(m, a.u(0));
      if (!w) { setError(m, 1400); return 0; }
      switch (a.i(1)) {
        case -4: return w.proc;
        case -6: return w.hInstance;
        case -8: return w.parent;
        case -12: return w.id;
        case -16: return w.style;
        case -20: return w.exStyle;
        case -21: return w.userData;
        default: return a.i(1) >= 0 ? w.extra[a.i(1) >> 2] : 0;
      }
    }],
    SetWindowLongA: [12, (m, a) => {
      const w = wnd(m, a.u(0));
      if (!w) { setError(m, 1400); return 0; }
      const v = a.u(2);
      let old = 0;
      switch (a.i(1)) {
        case -4: old = w.proc; w.proc = v; break;
        case -8: old = w.parent; w.parent = v; break;
        case -12: old = w.id; w.id = v; break;
        case -16: old = w.style; w.style = v; break;
        case -20: old = w.exStyle; w.exStyle = v; break;
        case -21: old = w.userData; w.userData = v; break;
        default: if (a.i(1) >= 0) { old = w.extra[a.i(1) >> 2]; w.extra[a.i(1) >> 2] = v; }
      }
      return old;
    }],
    GetWindowWord: [8, (m, a) => wnd(m, a.u(0))?.extra[a.i(1) >> 2] ?? 0],
    SetWindowWord: [12, (m, a) => { const w = wnd(m, a.u(0)); if (w) w.extra[a.i(1) >> 2] = a.u(2) & 0xffff; return 0; }],
    GetPropA: [8, (m, a) => wnd(m, a.u(0))?.props.get(propKey(m, a.u(1))) ?? 0],
    SetPropA: [12, (m, a) => { const w = wnd(m, a.u(0)); if (!w) return 0; w.props.set(propKey(m, a.u(1)), a.u(2)); return 1; }],
    RemovePropA: [8, (m, a) => {
      const w = wnd(m, a.u(0));
      if (!w) return 0;
      const k = propKey(m, a.u(1)), v = w.props.get(k) ?? 0;
      w.props.delete(k);
      return v;
    }],
    IsWindow: [4, (m, a) => (wnd(m, a.u(0)) ? 1 : 0)],
    IsWindowVisible: [4, (m, a) => (wnd(m, a.u(0))?.visible ? 1 : 0)],
    IsWindowEnabled: [4, (m, a) => (wnd(m, a.u(0))?.enabled ? 1 : 0)],
    EnableWindow: [8, (m, a) => { const w = wnd(m, a.u(0)); if (!w) return 0; const old = !w.enabled; w.enabled = a.u(1) !== 0; return old ? 1 : 0; }],
    IsIconic: [4, () => 0],
    IsZoomed: [4, () => 0],
    IsChild: [8, (m, a) => {
      let w = wnd(m, a.u(1));
      while (w) { if (w.parent === a.u(0)) return 1; w = wnd(m, w.parent); }
      return 0;
    }],
    GetParent: [4, (m, a) => { const w = wnd(m, a.u(0)); return w && w.style & 0x40000000 ? w.parent : 0; }],
    SetParent: [8, (m, a) => { const w = wnd(m, a.u(0)); if (!w) return 0; const old = w.parent; w.parent = a.u(1); return old; }],
    GetWindow: [8, (m, a) => {
      const s = u32(m), w = wnd(m, a.u(0));
      if (!w) return 0;
      const sibs = [...s.windows.values()].filter((x) => x.parent === w.parent);
      const i = sibs.indexOf(w);
      switch (a.u(1)) {
        case 0: return sibs[0]?.hwnd ?? 0;
        case 1: return sibs[sibs.length - 1]?.hwnd ?? 0;
        case 2: return sibs[i + 1]?.hwnd ?? 0;
        case 3: return sibs[i - 1]?.hwnd ?? 0;
        case 4: return w.style & 0x40000000 ? 0 : w.parent;
        case 5: return [...s.windows.values()].find((x) => x.parent === w.hwnd)?.hwnd ?? 0;
        default: return 0;
      }
    }],
    GetTopWindow: [4, (m, a) => [...u32(m).windows.values()].find((x) => x.parent === a.u(0))?.hwnd ?? 0],
    GetDesktopWindow: [0, (m) => u32(m).desktop],
    GetLastActivePopup: [4, (m, a) => a.u(0)],
    GetWindowThreadProcessId: [8, (m, a) => {
      const w = wnd(m, a.u(0));
      if (a.u(1)) m.mem.dv.setUint32(a.u(1), 0x10, true);
      return w ? w.thread.id : 0;
    }],
    FindWindowA: [8, (m, a) => {
      const cls = a.str(0)?.toUpperCase(), title = a.str(1);
      for (const w of u32(m).windows.values()) {
        if ((!cls || w.cls.name === cls) && (title === null || w.text === title)) return w.hwnd;
      }
      return 0;
    }],
    EnumWindows: [8, function* (m, a): HleGen {
      for (const w of [...u32(m).windows.values()].filter((x) => !x.parent)) {
        const r = yield { t: "call", addr: a.u(0), args: [w.hwnd, a.u(1)] };
        if (!r) break;
      }
      return 1;
    }],
    EnumChildWindows: [12, function* (m, a): HleGen {
      for (const w of [...u32(m).windows.values()].filter((x) => x.parent === a.u(0))) {
        const r = yield { t: "call", addr: a.u(1), args: [w.hwnd, a.u(2)] };
        if (!r) break;
      }
      return 1;
    }],
    GetDlgItem: [8, (m, a) => [...u32(m).windows.values()].find((x) => x.parent === a.u(0) && x.id === a.u(1))?.hwnd ?? 0],
    GetDlgCtrlID: [4, (m, a) => wnd(m, a.u(0))?.id ?? 0],
    GetWindowTextA: [12, (m, a) => { const w = wnd(m, a.u(0)); return w ? putA(m, a.u(1), a.u(2), w.text) : 0; }],
    GetWindowTextLengthA: [4, (m, a) => wnd(m, a.u(0))?.text.length ?? 0],
    SetWindowTextA: [8, (m, a) => { const w = wnd(m, a.u(0)); if (w) w.text = a.str(1) ?? ""; return 1; }],
    ShowWindow: [8, function* (m, a) {
      const w = wnd(m, a.u(0));
      if (!w) return 0;
      const was = w.visible;
      const show = a.u(1) !== 0;
      w.visible = show;
      if (was !== show) yield* sendMessage(m, w.hwnd, WM_SHOWWINDOW, show ? 1 : 0, 0);
      if (show && !(w.style & 0x40000000) && a.u(1) !== 4 && a.u(1) !== 8) yield* activate(m, w.hwnd);
      if (show) invalidateTree(u32(m), w);
      return was ? 1 : 0;
    }],
    UpdateWindow: [4, function* (m, a) {
      const w = wnd(m, a.u(0));
      if (w && w.invalid) { w.invalid = false; yield* sendMessage(m, w.hwnd, WM_PAINT, 0, 0); }
      return 1;
    }],
    SetWindowPos: [28, function* (m, a) { return yield* setWindowPos(m, a.u(0), a.i(2), a.i(3), a.i(4), a.i(5), a.u(6)); }],
    BeginDeferWindowPos: [4, () => 0x9400],
    DeferWindowPos: [32, function* (m, a) { yield* setWindowPos(m, a.u(1), a.i(3), a.i(4), a.i(5), a.i(6), a.u(7)); return a.u(0); }],
    EndDeferWindowPos: [4, () => 1],
    MoveWindow: [24, function* (m, a) {
      const w = wnd(m, a.u(0));
      if (!w) return 0;
      w.rect = { l: a.i(1), t: a.i(2), r: a.i(1) + a.i(3), b: a.i(2) + a.i(4) };
      yield* sendMessage(m, w.hwnd, WM_SIZE, 0, ((a.i(4) & 0xffff) << 16) | (a.i(3) & 0xffff));
      return 1;
    }],
    BringWindowToTop: [4, () => 1],
    GetWindowRect: [8, (m, a) => {
      const w = wnd(m, a.u(0));
      if (a.u(0) === u32(m).desktop) { writeRect(m, a.u(1), { l: 0, t: 0, r: u32(m).screenW, b: u32(m).screenH }); return 1; }
      if (!w) return 0;
      writeRect(m, a.u(1), w.rect);
      return 1;
    }],
    GetClientRect: [8, (m, a) => {
      const w = wnd(m, a.u(0));
      if (a.u(0) === u32(m).desktop) { writeRect(m, a.u(1), { l: 0, t: 0, r: u32(m).screenW, b: u32(m).screenH }); return 1; }
      if (!w) return 0;
      writeRect(m, a.u(1), clientRect(w));
      return 1;
    }],
    GetWindowPlacement: [8, (m, a) => {
      const w = wnd(m, a.u(0));
      if (!w) return 0;
      const p = a.u(1);
      m.mem.dv.setUint32(p, 44, true);
      m.mem.dv.setUint32(p + 8, w.visible ? 1 : 0, true);
      writeRect(m, p + 28, w.rect);
      return 1;
    }],
    SetWindowPlacement: [8, () => 1],
    AdjustWindowRect: [12, () => 1],
    AdjustWindowRectEx: [16, () => 1],
    ClientToScreen: [8, (m, a) => {
      const w = wnd(m, a.u(0));
      if (w) { m.mem.dv.setInt32(a.u(1), m.mem.dv.getInt32(a.u(1), true) + w.rect.l, true); m.mem.dv.setInt32(a.u(1) + 4, m.mem.dv.getInt32(a.u(1) + 4, true) + w.rect.t, true); }
      return 1;
    }],
    ScreenToClient: [8, (m, a) => {
      const w = wnd(m, a.u(0));
      if (w) { m.mem.dv.setInt32(a.u(1), m.mem.dv.getInt32(a.u(1), true) - w.rect.l, true); m.mem.dv.setInt32(a.u(1) + 4, m.mem.dv.getInt32(a.u(1) + 4, true) - w.rect.t, true); }
      return 1;
    }],
    MapWindowPoints: [16, () => 0],
    WindowFromPoint: [8, (m) => u32(m).active],
    ChildWindowFromPoint: [12, (m, a) => a.u(0)],
    InvalidateRect: [12, (m, a) => { const w = wnd(m, a.u(0)); if (w) w.invalid = true; return 1; }],
    InvalidateRgn: [12, (m, a) => { const w = wnd(m, a.u(0)); if (w) w.invalid = true; return 1; }],
    ValidateRect: [8, (m, a) => { const w = wnd(m, a.u(0)); if (w) w.invalid = false; return 1; }],
    RedrawWindow: [16, () => 1],
    GetUpdateRect: [12, () => 0],
    BeginPaint: [8, (m, a) => {
      const w = wnd(m, a.u(0));
      if (w) w.invalid = false;
      const p = a.u(1);
      m.mem.fill(p, 64, 0);
      const hdc = m.sub.gdiGetDC ? m.sub.gdiGetDC(a.u(0)) : 0x5000;
      m.mem.dv.setUint32(p, hdc, true);
      if (w) writeRect(m, p + 8, clientRect(w));
      return hdc;
    }],
    EndPaint: [8, () => 1],
    GetSystemMetrics: [4, (m, a) => {
      const s = u32(m);
      const tbl: Record<number, number> = { 0: s.screenW, 1: s.screenH, 2: 16, 3: 16, 4: 19, 5: 1, 6: 1, 7: 3, 8: 3, 11: 32, 12: 32,
        13: 32, 14: 32, 15: 19, 16: s.screenW, 17: s.screenH - 28, 19: 1, 20: 16, 21: 16, 28: 112, 29: 27, 30: 18, 31: 18, 32: 4, 33: 4,
        34: 112, 35: 27, 36: 4, 37: 4, 43: 3, 49: 16, 50: 16, 59: s.screenW, 60: s.screenH, 61: s.screenW, 62: s.screenH, 78: s.screenW, 79: s.screenH, 80: 1 };
      return tbl[a.i(0)] ?? 0;
    }],
    SystemParametersInfoA: [16, (m, a) => {
      const s = u32(m);
      switch (a.u(0)) {
        case 48: writeRect(m, a.u(2), { l: 0, t: 0, r: s.screenW, b: s.screenH - 28 }); return 1;
        case 16: if (a.u(2)) m.mem.dv.setUint32(a.u(2), 0, true); return 1;
        case 0x2f: if (a.u(2)) m.mem.dv.setUint32(a.u(2), 0, true); return 1;
        default: if (a.u(2) && a.u(0) < 0x40 && a.u(0) !== 17 && a.u(0) !== 97) m.mem.dv.setUint32(a.u(2), 0, true); return 1;
      }
    }],
    GetSysColor: [4, (m, a) => [0xc8d0d4, 0x6b2408, 0x6a240a, 0x808080, 0xc8d0d4, 0xffffff, 0, 0, 0, 0xffffff, 0xc8d0d4,
      0xc8d0d4, 0x808080, 0x6a240a, 0xffffff, 0xc8d0d4, 0x808080, 0x808080, 0, 0xc8d0d4, 0xffffff][a.u(0)] ?? 0],
    GetSysColorBrush: [4, (m, a) => 0x8000 + a.u(0)],

    SetFocus: [4, function* (m, a) {
      const s = u32(m), old = s.focus;
      if (old === a.u(0)) return old;
      s.focus = a.u(0);
      if (old) yield* sendMessage(m, old, WM_KILLFOCUS, a.u(0), 0);
      if (a.u(0)) yield* sendMessage(m, a.u(0), WM_SETFOCUS, old, 0);
      return old;
    }],
    GetFocus: [0, (m) => u32(m).focus],
    SetActiveWindow: [4, function* (m, a) { const old = u32(m).active; yield* activate(m, a.u(0)); return old; }],
    GetActiveWindow: [0, (m) => u32(m).active],
    SetForegroundWindow: [4, function* (m, a) { yield* activate(m, a.u(0)); return 1; }],
    GetForegroundWindow: [0, (m) => u32(m).active],
    SetCapture: [4, (m, a) => { const s = u32(m), old = s.capture; s.capture = a.u(0); return old; }],
    ReleaseCapture: [0, (m) => { u32(m).capture = 0; return 1; }],
    GetCapture: [0, (m) => u32(m).capture],
    AttachThreadInput: [12, () => 1],

    SetTimer: [16, (m, a) => {
      const s = u32(m);
      const id = a.u(0) ? a.u(1) : 0x1000 + s.timers.length;
      s.timers = s.timers.filter((t) => !(t.hwnd === a.u(0) && t.id === id));
      s.timers.push({ hwnd: a.u(0), id, interval: a.u(2), next: m.now() + a.u(2), proc: a.u(3), thread: m.cur! });
      return id;
    }],
    KillTimer: [8, (m, a) => {
      const s = u32(m);
      s.timers = s.timers.filter((t) => !(t.hwnd === a.u(0) && t.id === a.u(1)));
      return 1;
    }],

    ShowCursor: [4, (m, a) => { const s = u32(m); s.cursorShow += a.u(0) ? 1 : -1; return s.cursorShow; }],
    SetCursor: [4, (m, a) => { const old = m.sub.cursor ?? 0; m.sub.cursor = a.u(0); return old; }],
    GetCursor: [0, (m) => m.sub.cursor ?? 0],
    LoadCursorA: [8, (m, a) => 0x6000 + (a.u(1) & 0xfff)],
    LoadIconA: [8, (m, a) => 0x6800 + (a.u(1) & 0xfff)],
    LoadImageA: [24, (m, a) => 0x6800 + (a.u(1) & 0xfff)],
    DestroyCursor: [4, () => 1],
    DestroyIcon: [4, () => 1],
    DrawIcon: [16, () => 1],
    GetCursorPos: [4, (m, a) => {
      const s = u32(m);
      m.mem.dv.setInt32(a.u(0), s.cursorPos.x, true);
      m.mem.dv.setInt32(a.u(0) + 4, s.cursorPos.y, true);
      return 1;
    }],
    SetCursorPos: [8, (m, a) => { const s = u32(m); s.cursorPos = { x: a.i(0), y: a.i(1) }; return 1; }],
    ClipCursor: [4, () => 1],
    GetKeyState: [4, (m, a) => {
      const v = u32(m).keyState[a.u(0) & 0xff];
      return ((v & 0x80 ? 0xff80 : 0) | (v & 1)) << 16 >> 16;
    }],
    GetAsyncKeyState: [4, (m, a) => ((u32(m).keyState[a.u(0) & 0xff] & 0x80) ? 0x8000 : 0)],
    GetKeyboardState: [4, (m, a) => { m.mem.u8.set(u32(m).keyState, a.u(0)); return 1; }],
    SetKeyboardState: [4, (m, a) => { u32(m).keyState.set(m.mem.u8.subarray(a.u(0), a.u(0) + 256)); return 1; }],
    GetKeyboardLayoutNameA: [4, (m, a) => { m.mem.writeCString(a.u(0), "00000409"); return 1; }],
    GetKeyboardLayout: [4, () => 0x04090409],
    LoadKeyboardLayoutA: [8, () => 0x04090409],
    ActivateKeyboardLayout: [8, () => 0x04090409],
    GetKeyboardType: [4, (m, a) => [4, 0, 12][a.u(0)] ?? 0],
    MapVirtualKeyA: [8, (m, a) => mapVk(a.u(0), a.u(1))],
    MapVirtualKeyExA: [12, (m, a) => mapVk(a.u(0), a.u(1))],
    VkKeyScanA: [4, (m, a) => {
      const c = String.fromCharCode(a.u(0) & 0xff).toUpperCase().charCodeAt(0);
      return c >= 0x41 && c <= 0x5a ? c : c >= 0x30 && c <= 0x39 ? c : 0xffff;
    }],
    ToAscii: [20, (m, a) => toAscii(m, a.u(0), a.u(2), a.u(3))],
    ToAsciiEx: [24, (m, a) => toAscii(m, a.u(0), a.u(2), a.u(3))],
    GetKeyNameTextA: [12, (m, a) => {
      const sc = (a.u(0) >> 16) & 0xff;
      const vk = SCAN_TO_VK[sc] ?? 0;
      const names: Record<number, string> = { 0x20: "Space", 0x0d: "Enter", 0x1b: "Esc", 0x10: "Shift", 0x11: "Ctrl", 0x12: "Alt",
        0x26: "Up", 0x28: "Down", 0x25: "Left", 0x27: "Right", 0x09: "Tab", 0x08: "Backspace" };
      const n = names[vk] ?? (vkToChar(vk, true) ? String.fromCharCode(vkToChar(vk, true)) : vk >= 0x70 && vk <= 0x7b ? `F${vk - 0x6f}` : "");
      return putA(m, a.u(1), a.i(2), n);
    }],

    MessageBoxA: [16, (m, a) => {
      m.log(`MessageBox [${a.str(2)}]: ${a.str(1)}`);
      (m.sub.messageBoxes ??= []).push(`${a.str(2)}: ${a.str(1)}`);
      const type = a.u(3) & 0xf;
      return type === 4 || type === 3 ? 6 : 1;
    }],
    MessageBeep: [4, () => 1],
    FlashWindow: [8, () => 1],

    LoadStringA: [16, (m, a) => {
      const mod = m.modules.find((x) => x.base === a.u(0)) ?? m.exe!;
      const s = loadString(m, mod, a.u(1));
      if (s === null) { if (a.u(2) && a.i(3) > 0) m.mem.u8[a.u(2)] = 0; return 0; }
      return putA(m, a.u(2), a.i(3), s);
    }],
    CharUpperA: [4, (m, a) => {
      const p = a.u(0);
      if (p < 0x10000) return String.fromCharCode(p).toUpperCase().charCodeAt(0);
      m.mem.writeCString(p, m.mem.readCString(p).toUpperCase());
      return p;
    }],
    CharLowerA: [4, (m, a) => {
      const p = a.u(0);
      if (p < 0x10000) return String.fromCharCode(p).toLowerCase().charCodeAt(0);
      m.mem.writeCString(p, m.mem.readCString(p).toLowerCase());
      return p;
    }],
    CharUpperBuffA: [8, (m, a) => { for (let i = 0; i < a.u(1); i++) { const c = m.mem.u8[a.u(0) + i]; m.mem.u8[a.u(0) + i] = c >= 97 && c <= 122 ? c - 32 : c; } return a.u(1); }],
    CharLowerBuffA: [8, (m, a) => { for (let i = 0; i < a.u(1); i++) { const c = m.mem.u8[a.u(0) + i]; m.mem.u8[a.u(0) + i] = c >= 65 && c <= 90 ? c + 32 : c; } return a.u(1); }],
    CharNextA: [4, (m, a) => (m.mem.u8[a.u(0)] ? a.u(0) + 1 : a.u(0))],
    CharPrevA: [8, (m, a) => (a.u(1) > a.u(0) ? a.u(1) - 1 : a.u(0))],
    CharToOemA: [8, (m, a) => { m.mem.writeCString(a.u(1), a.str(0) ?? ""); return 1; }],
    OemToCharA: [8, (m, a) => { m.mem.writeCString(a.u(1), a.str(0) ?? ""); return 1; }],
    IsCharAlphaA: [4, (m, a) => (/[a-zA-Z\xc0-\xff]/.test(String.fromCharCode(a.u(0) & 0xff)) ? 1 : 0)],
    IsCharAlphaNumericA: [4, (m, a) => (/[a-zA-Z0-9\xc0-\xff]/.test(String.fromCharCode(a.u(0) & 0xff)) ? 1 : 0)],
    wsprintfA: [-1 >>> 0 === 0xffffffff ? 0 : 0, (m, a) => {
      const s = formatPrintf(m, m.mem.readCString(a.u(1)), a.base + 8);
      m.mem.writeCString(a.u(0), s.slice(0, 1023));
      return Math.min(s.length, 1023);
    }],
    wvsprintfA: [12, (m, a) => {
      const s = formatPrintf(m, m.mem.readCString(a.u(1)), a.u(2));
      m.mem.writeCString(a.u(0), s.slice(0, 1023));
      return Math.min(s.length, 1023);
    }],
    CopyRect: [8, (m, a) => { writeRect(m, a.u(0), readRect(m, a.u(1))); return 1; }],
    SetRect: [20, (m, a) => { writeRect(m, a.u(0), { l: a.i(1), t: a.i(2), r: a.i(3), b: a.i(4) }); return 1; }],
    SetRectEmpty: [4, (m, a) => { writeRect(m, a.u(0), { l: 0, t: 0, r: 0, b: 0 }); return 1; }],
    IsRectEmpty: [4, (m, a) => { const r = readRect(m, a.u(0)); return r.r <= r.l || r.b <= r.t ? 1 : 0; }],
    OffsetRect: [12, (m, a) => { const r = readRect(m, a.u(0)); writeRect(m, a.u(0), { l: r.l + a.i(1), t: r.t + a.i(2), r: r.r + a.i(1), b: r.b + a.i(2) }); return 1; }],
    InflateRect: [12, (m, a) => { const r = readRect(m, a.u(0)); writeRect(m, a.u(0), { l: r.l - a.i(1), t: r.t - a.i(2), r: r.r + a.i(1), b: r.b + a.i(2) }); return 1; }],
    PtInRect: [12, (m, a) => { const r = readRect(m, a.u(0)); return a.i(1) >= r.l && a.i(1) < r.r && a.i(2) >= r.t && a.i(2) < r.b ? 1 : 0; }],
    EqualRect: [8, (m, a) => { const x = readRect(m, a.u(0)), y = readRect(m, a.u(1)); return x.l === y.l && x.t === y.t && x.r === y.r && x.b === y.b ? 1 : 0; }],
    IntersectRect: [12, (m, a) => {
      const x = readRect(m, a.u(1)), y = readRect(m, a.u(2));
      const r = { l: Math.max(x.l, y.l), t: Math.max(x.t, y.t), r: Math.min(x.r, y.r), b: Math.min(x.b, y.b) };
      if (r.r <= r.l || r.b <= r.t) { writeRect(m, a.u(0), { l: 0, t: 0, r: 0, b: 0 }); return 0; }
      writeRect(m, a.u(0), r);
      return 1;
    }],
    UnionRect: [12, (m, a) => {
      const x = readRect(m, a.u(1)), y = readRect(m, a.u(2));
      writeRect(m, a.u(0), { l: Math.min(x.l, y.l), t: Math.min(x.t, y.t), r: Math.max(x.r, y.r), b: Math.max(x.b, y.b) });
      return 1;
    }],

    GetMenu: [4, (m, a) => wnd(m, a.u(0))?.menu ?? 0],
    SetMenu: [8, (m, a) => { const w = wnd(m, a.u(0)); if (w) w.menu = a.u(1); return 1; }],
    GetSystemMenu: [8, () => 0x9000],
    EnableMenuItem: [12, () => 0],
    CheckMenuItem: [12, () => 0],
    GetSubMenu: [8, () => 0],
    GetMenuItemCount: [4, () => 0],
    GetMenuItemID: [8, () => 0xffffffff],
    GetMenuState: [12, () => 0xffffffff],
    GetMenuStringA: [20, () => 0],
    DeleteMenu: [12, () => 1],
    RemoveMenu: [12, () => 1],
    AppendMenuA: [16, () => 1],
    InsertMenuA: [20, () => 1],
    ModifyMenuA: [20, () => 1],
    CreateMenu: [0, () => 0x9100],
    CreatePopupMenu: [0, () => 0x9200],
    DestroyMenu: [4, () => 1],
    LoadMenuA: [8, () => 0x9300],
    DrawMenuBar: [4, () => 1],
    TrackPopupMenu: [28, () => 0],
    LoadAcceleratorsA: [8, () => 0x9300],
    DestroyAcceleratorTable: [4, () => 1],
    GetDC: [4, (m, a) => (m.sub.gdiGetDC ? m.sub.gdiGetDC(a.u(0)) : 0x5000)],
    GetWindowDC: [4, (m, a) => (m.sub.gdiGetDC ? m.sub.gdiGetDC(a.u(0)) : 0x5000)],
    GetDCEx: [12, (m, a) => (m.sub.gdiGetDC ? m.sub.gdiGetDC(a.u(0)) : 0x5000)],
    ReleaseDC: [8, () => 1],
    FillRect: [12, () => 1],
    FrameRect: [12, () => 1],
    DrawTextA: [20, () => 16],
    DrawFocusRect: [8, () => 1],
    DrawEdge: [16, () => 1],
    GrayStringA: [36, () => 1],
    TabbedTextOutA: [32, () => 0],
    ScrollWindowEx: [32, () => 0],
    GetScrollPos: [8, () => 0],
    SetScrollPos: [16, () => 0],
    GetScrollRange: [16, () => 1],
    SetScrollRange: [20, () => 1],
    ShowScrollBar: [12, () => 1],
    EnableScrollBar: [12, () => 1],
    GetScrollInfo: [12, () => 0],
    SetScrollInfo: [16, () => 0],
    CreateDialogParamA: [20, () => 0],
    CreateDialogIndirectParamA: [20, () => 0],
    DialogBoxParamA: [20, (m) => { m.log("DialogBoxParam -> IDCANCEL"); return 2; }],
    DialogBoxIndirectParamA: [20, (m) => { m.log("DialogBoxIndirectParam -> IDCANCEL"); return 2; }],
    EndDialog: [8, () => 1],
    GetNextDlgTabItem: [12, () => 0],
    GetNextDlgGroupItem: [12, () => 0],
    SendDlgItemMessageA: [20, () => 0],
    SetDlgItemTextA: [12, () => 1],
    GetDlgItemTextA: [16, () => 0],
    CheckDlgButton: [12, () => 1],
    IsDlgButtonChecked: [8, () => 0],
    MapDialogRect: [8, () => 1],
    GetDialogBaseUnits: [0, () => 0x00100008],
    WinHelpA: [16, () => 1],
    GetClipboardData: [4, () => 0],
    OpenClipboard: [4, () => 0],
    CloseClipboard: [0, () => 1],
    IsClipboardFormatAvailable: [4, () => 0],
    RegisterClipboardFormatA: [4, () => 0xc200],
    ChangeDisplaySettingsA: [8, () => 0],
    EnumDisplaySettingsA: [12, (m, a) => {
      const modes = [[640, 480], [800, 600], [1024, 768]];
      const i = a.u(1) === 0xffffffff ? 2 : a.u(1);
      if (i >= modes.length * 2) return 0;
      const p = a.u(2), dv = m.mem.dv;
      dv.setUint32(p + 104, i % 2 ? 32 : 16, true);
      dv.setUint32(p + 108, modes[Math.floor(i / 2) % 3][0], true);
      dv.setUint32(p + 112, modes[Math.floor(i / 2) % 3][1], true);
      dv.setUint32(p + 120, 60, true);
      return 1;
    }],
  };
  m0.register("user32.dll", u);
  m0.register("user32.dll", { wsprintfA: [0, u.wsprintfA[1]] });
}

function propKey(m: Machine, p: number): string {
  return p < 0x10000 ? `#${p}` : m.mem.readCString(p).toUpperCase();
}

function mapVk(code: number, type: number): number {
  switch (type) {
    case 0: return VK_TO_SCAN[code] ?? 0;
    case 1: case 3: return SCAN_TO_VK[code & 0x7f] ?? 0;
    case 2: return vkToChar(code, true);
    default: return 0;
  }
}

function toAscii(m: Machine, vk: number, statePtr: number, out: number): number {
  const shift = statePtr ? (m.mem.u8[statePtr + 0x10] & 0x80) !== 0 : false;
  const ch = vkToChar(vk, shift);
  if (!ch || !out) return 0;
  m.mem.dv.setUint16(out, ch, true);
  return 1;
}

function nextTimerDelay(m: Machine, t: Thread): number {
  const s = u32(m);
  let d = 0xffffffff;
  for (const tm of s.timers) if (tm.thread === t) d = Math.min(d, Math.max(0, tm.next - m.now()));
  return d;
}

void cp1252;
