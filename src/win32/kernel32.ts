import { EAX, ESP } from "../cpu/cpu";
import { Machine, Args, hex, baseName, waitFor, type GuestModule } from "./machine";
import { KObject, KEvent, KMutex, KSemaphore, KProcess, KGeneric } from "./objects";
import type { HleGen } from "./thread";
import { Thread } from "./thread";
import { VNode, DRIVE_CDROM, DRIVE_FIXED } from "./vfs";
import { roundUp } from "./mm";
import { findResource } from "./resources";
import { iniGet, iniSet } from "./ini";

const INVALID = 0xffffffff;
const ERROR_FILE_NOT_FOUND = 2, ERROR_PATH_NOT_FOUND = 3, ERROR_ACCESS_DENIED = 5, ERROR_INVALID_HANDLE = 6;
const ERROR_NO_MORE_FILES = 18, ERROR_FILE_EXISTS = 80, ERROR_INSUFFICIENT_BUFFER = 122, ERROR_ALREADY_EXISTS = 183;
const ERROR_MOD_NOT_FOUND = 126, ERROR_PROC_NOT_FOUND = 127, ERROR_NOT_OWNER = 288, ERROR_INVALID_PARAMETER = 87;
const ERROR_NO_MORE_ITEMS = 259;

export class KFile extends KObject {
  readonly kind = "file";
  pos = 0;
  dirty = false;
  constructor(
    public node: VNode,
    public canWrite: boolean,
    public path: string,
  ) {
    super();
  }
  override close(): void {
    if (this.dirty) this.vfsFlush?.(this.node);
  }
  vfsFlush: ((n: VNode) => void) | null = null;
}
class KConsole extends KObject {
  readonly kind = "console";
  buf = "";
  constructor(public which: number) {
    super();
  }
}
class KFind extends KObject {
  readonly kind = "find";
  constructor(
    public entries: VNode[],
    public idx: number,
  ) {
    super();
  }
}

export function setError(m: Machine, code: number): void {
  if (m.cur) m.cur.lastError = code;
}

/** Copies a string into a guest buffer of `size` chars; returns chars written (excluding NUL) or 0 if truncated. */
export function putA(m: Machine, ptr: number, size: number, s: string): number {
  if (!ptr || size <= 0) return 0;
  const n = Math.min(s.length, size - 1);
  for (let i = 0; i < n; i++) m.mem.u8[ptr + i] = s.charCodeAt(i) & 0xff;
  m.mem.u8[ptr + n] = 0;
  return n;
}
export function putW(m: Machine, ptr: number, size: number, s: string): number {
  if (!ptr || size <= 0) return 0;
  const n = Math.min(s.length, size - 1);
  for (let i = 0; i < n; i++) m.mem.dv.setUint16(ptr + i * 2, s.charCodeAt(i), true);
  m.mem.dv.setUint16(ptr + n * 2, 0, true);
  return n;
}

export function obj<T extends KObject>(m: Machine, h: number): T | undefined {
  h >>>= 0;
  if (h === 0xfffffffe) return m.cur as unknown as T;
  if (h === 0xffffffff) return (m.sub.process ??= new KProcess()) as T;
  return m.handles.get<T>(h);
}

function fileTime(ms: number): [number, number] {
  const t = BigInt(Math.floor(ms)) * 10000n + 116444736000000000n;
  return [Number(t & 0xffffffffn), Number(t >> 32n)];
}
function msFromFileTime(lo: number, hi: number): number {
  const t = (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
  return Number((t - 116444736000000000n) / 10000n);
}
function writeFileTime(m: Machine, p: number, ms: number): void {
  if (!p) return;
  const [lo, hi] = fileTime(ms);
  m.mem.dv.setUint32(p, lo, true);
  m.mem.dv.setUint32(p + 4, hi, true);
}
function writeSystemTime(m: Machine, p: number, d: Date, utc: boolean): void {
  const dv = m.mem.dv;
  const f = utc
    ? [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDay(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()]
    : [d.getFullYear(), d.getMonth() + 1, d.getDay(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()];
  f.forEach((v, i) => dv.setUint16(p + i * 2, v, true));
}

function attrsOf(n: VNode): number {
  if (n.isDir) return 0x10;
  return (n.readonly ? 1 : 0) | (n.attrs || 0x20);
}

function writeFindData(m: Machine, p: number, n: VNode, wide: boolean): void {
  const dv = m.mem.dv;
  m.mem.u8.fill(0, p, p + (wide ? 592 : 320));
  dv.setUint32(p, attrsOf(n), true);
  writeFileTime(m, p + 4, n.mtime);
  writeFileTime(m, p + 12, n.mtime);
  writeFileTime(m, p + 20, n.mtime);
  dv.setUint32(p + 28, 0, true);
  dv.setUint32(p + 32, n.length, true);
  if (wide) {
    putW(m, p + 44, 260, n.name);
    putW(m, p + 44 + 520, 14, shortName(n.name));
  } else {
    putA(m, p + 44, 260, n.name);
    putA(m, p + 44 + 260, 14, shortName(n.name));
  }
}
function shortName(n: string): string {
  return n.length <= 12 && !n.includes(" ") ? n.toUpperCase() : "";
}

// ---------- critical sections ----------

function csMutex(m: Machine, addr: number): KMutex {
  const map: Map<number, KMutex> = (m.sub.cs ??= new Map());
  let mu = map.get(addr);
  if (!mu) map.set(addr, (mu = new KMutex()));
  return mu;
}

// ---------- environment ----------

export function setupProcess(m: Machine, cmdLine: string, env: Record<string, string>): void {
  m.cmdLine = cmdLine;
  m.cmdLineA = m.sysString(cmdLine);
  m.cmdLineW = m.sysAlloc(cmdLine.length * 2 + 2);
  m.mem.writeWString(m.cmdLineW, cmdLine);
  m.sub.env = new Map(Object.entries(env).map(([k, v]) => [k.toUpperCase(), [k, v]]));
  m.peb = m.sysAlloc(0x1000, 0x1000);
  m.mem.dv.setUint32(m.peb + 0x18, m.processHeap.handle, true);
}
function envBlock(m: Machine, wide: boolean): number {
  const env: Map<string, [string, string]> = m.sub.env;
  const s = [...env.values()].map(([k, v]) => `${k}=${v}\0`).join("") + "\0";
  if (wide) {
    const p = m.processHeap.alloc(s.length * 2, false);
    for (let i = 0; i < s.length; i++) m.mem.dv.setUint16(p + i * 2, s.charCodeAt(i), true);
    return p;
  }
  const p = m.processHeap.alloc(s.length, false);
  for (let i = 0; i < s.length; i++) m.mem.u8[p + i] = s.charCodeAt(i);
  return p;
}

// ---------- files ----------

function openFile(m: Machine, path: string | null, access: number, disp: number, flags: number): number {
  if (!path) {
    setError(m, ERROR_PATH_NOT_FOUND);
    return INVALID;
  }
  if (/^\\\\\.\\/.test(path) || /^(CON|NUL|AUX|PRN)$/i.test(path)) {
    setError(m, ERROR_FILE_NOT_FOUND);
    return INVALID;
  }
  const full = m.vfs.full(path);
  if (!full) {
    setError(m, ERROR_PATH_NOT_FOUND);
    return INVALID;
  }
  const write = (access & 0x40000000) !== 0 || (access & 0x10000000) !== 0;
  let node = m.vfs.lookup(full);
  if (node && node.isDir) {
    setError(m, ERROR_ACCESS_DENIED);
    return INVALID;
  }
  // disp: 1 CREATE_NEW, 2 CREATE_ALWAYS, 3 OPEN_EXISTING, 4 OPEN_ALWAYS, 5 TRUNCATE_EXISTING
  let err = 0;
  if (disp === 1 && node) {
    setError(m, ERROR_FILE_EXISTS);
    return INVALID;
  }
  if ((disp === 3 || disp === 5) && !node) {
    setError(m, m.vfs.parentOf(full) ? ERROR_FILE_NOT_FOUND : ERROR_PATH_NOT_FOUND);
    return INVALID;
  }
  if (write && node && node.readonly) {
    setError(m, ERROR_ACCESS_DENIED);
    return INVALID;
  }
  if (!node || disp === 2) {
    if (node && disp === 2) err = ERROR_ALREADY_EXISTS;
    node = m.vfs.create(full);
    if (!node) {
      setError(m, ERROR_PATH_NOT_FOUND);
      return INVALID;
    }
  } else if (disp === 4) err = ERROR_ALREADY_EXISTS;
  if (disp === 5) node.truncate(0);
  const f = new KFile(node, write, full);
  f.vfsFlush = (n) => m.vfs.flush(n);
  if (disp === 2 || (node.data && node.persist && node.size === 0)) f.dirty = true;
  setError(m, err);
  void flags;
  return m.handles.add(f);
}

function fileAttributes(m: Machine, path: string | null): number {
  if (!path) return INVALID;
  const n = m.vfs.lookup(path);
  if (!n) {
    setError(m, m.vfs.parentOf(path) ? ERROR_FILE_NOT_FOUND : ERROR_PATH_NOT_FOUND);
    return INVALID;
  }
  return attrsOf(n);
}

function findFirst(m: Machine, pattern: string | null, p: number, wide: boolean): number {
  if (!pattern) return INVALID;
  const entries = m.vfs.find(pattern);
  const full = m.vfs.full(pattern) ?? "";
  const lastPart = full.slice(full.lastIndexOf("\\") + 1);
  const all = [...entries];
  if (/^\*(\.\*)?$/.test(lastPart)) {
    const dir = m.vfs.lookup(full.slice(0, full.lastIndexOf("\\")) || full.slice(0, 3));
    if (dir && dir.parent) {
      const dot = new VNode(".", true, null), dotdot = new VNode("..", true, null);
      all.unshift(dot, dotdot);
    }
  }
  if (!all.length) {
    setError(m, ERROR_FILE_NOT_FOUND);
    return INVALID;
  }
  writeFindData(m, p, all[0], wide);
  return m.handles.add(new KFind(all, 1));
}

// ---------- registration ----------

export function registerKernel32(m0: Machine): void {
  const k: Record<string, [number, (m: Machine, a: Args) => number | void | HleGen]> = {
    // process & environment
    GetCommandLineA: [0, (m) => m.cmdLineA],
    GetCommandLineW: [0, (m) => m.cmdLineW],
    GetStartupInfoA: [4, (m, a) => {
      const p = a.u(0);
      m.mem.u8.fill(0, p, p + 68);
      m.mem.dv.setUint32(p, 68, true);
    }],
    GetStdHandle: [4, (m, a) => {
      const which = a.i(0);
      if (which === -10) return 0;
      const key = `std${which}`;
      return (m.sub[key] ??= m.handles.add(new KConsole(which)));
    }],
    SetStdHandle: [8, () => 1],
    GetFileType: [4, (m, a) => {
      const o = obj(m, a.u(0));
      if (!o) return 0;
      return o.kind === "console" ? 2 : o.kind === "file" ? 1 : 0;
    }],
    SetHandleCount: [4, (m, a) => a.u(0)],
    GetEnvironmentStrings: [0, (m) => envBlock(m, false)],
    GetEnvironmentStringsA: [0, (m) => envBlock(m, false)],
    GetEnvironmentStringsW: [0, (m) => envBlock(m, true)],
    FreeEnvironmentStringsA: [4, (m, a) => (m.processHeap.free(a.u(0)), 1)],
    FreeEnvironmentStringsW: [4, (m, a) => (m.processHeap.free(a.u(0)), 1)],
    GetEnvironmentVariableA: [12, (m, a) => {
      const e = (m.sub.env as Map<string, [string, string]>).get((a.str(0) ?? "").toUpperCase());
      if (!e) { setError(m, 203); return 0; }
      if (a.u(2) <= e[1].length) return e[1].length + 1;
      return putA(m, a.u(1), a.u(2), e[1]);
    }],
    SetEnvironmentVariableA: [8, (m, a) => {
      const k = a.str(0) ?? "", v = a.str(1);
      const env = m.sub.env as Map<string, [string, string]>;
      if (v === null) env.delete(k.toUpperCase());
      else env.set(k.toUpperCase(), [k, v]);
      return 1;
    }],
    SetEnvironmentVariableW: [8, (m, a) => {
      const k = a.wstr(0) ?? "", v = a.wstr(1);
      const env = m.sub.env as Map<string, [string, string]>;
      if (v === null) env.delete(k.toUpperCase());
      else env.set(k.toUpperCase(), [k, v]);
      return 1;
    }],
    GetVersion: [0, () => 0x05650004],
    GetVersionExA: [4, (m, a) => {
      const p = a.u(0), dv = m.mem.dv;
      const size = dv.getUint32(p, true);
      dv.setUint32(p + 4, 4, true);
      dv.setUint32(p + 8, 0, true);
      dv.setUint32(p + 12, 1381, true);
      dv.setUint32(p + 16, 2, true);
      putA(m, p + 20, 128, "Service Pack 6");
      if (size >= 156) m.mem.u8.fill(0, p + 148, p + 156);
      return 1;
    }],
    GetProcessVersion: [4, () => 0x00040000],
    GetCurrentProcess: [0, () => 0xffffffff],
    GetCurrentProcessId: [0, () => 0x10],
    GetCurrentThread: [0, () => 0xfffffffe],
    GetCurrentThreadId: [0, (m) => m.cur!.id],
    ExitProcess: [4, (m, a) => { m.exitProcess(a.u(0)); }],
    TerminateProcess: [8, (m, a) => {
      if (a.u(0) === 0xffffffff) m.exitProcess(a.u(1));
      return 1;
    }],
    GetExitCodeProcess: [8, (m, a) => { m.mem.dv.setUint32(a.u(1), 0x103, true); return 1; }],
    FatalAppExitA: [8, (m, a) => {
      m.log(`FatalAppExit: ${a.str(1)}`);
      m.fatal = new Error(`FatalAppExit: ${a.str(1)}`);
      m.exitProcess(0xff);
    }],
    SetErrorMode: [4, (m, a) => { const old = m.sub.errorMode ?? 0; m.sub.errorMode = a.u(0); return old; }],
    SetUnhandledExceptionFilter: [4, (m, a) => { const old = m.unhandledFilter; m.unhandledFilter = a.u(0); return old; }],
    UnhandledExceptionFilter: [4, (m, a) => {
      const rec = m.mem.dv.getUint32(a.u(0), true);
      m.log(`UnhandledExceptionFilter: code ${hex(m.mem.dv.getUint32(rec, true))} at ${hex(m.mem.dv.getUint32(rec + 12, true))}`);
      return 1;
    }],
    DebugBreak: [0, (m) => { m.log(`DebugBreak called from ${m.backtrace(6).join(" <- ")}`); }],
    OutputDebugStringA: [4, (m, a) => { m.log(`ODS: ${(a.str(0) ?? "").replace(/\s+$/, "")}`); }],
    CreateProcessA: [40, (m) => { setError(m, ERROR_FILE_NOT_FOUND); return 0; }],
    CreateProcessW: [40, (m) => { setError(m, ERROR_FILE_NOT_FOUND); return 0; }],
    CreatePipe: [16, () => 0],
    PeekNamedPipe: [24, () => 0],
    GetConsoleMode: [8, () => 0],
    SetConsoleMode: [8, () => 0],
    SetConsoleCtrlHandler: [8, () => 1],
    GetNumberOfConsoleInputEvents: [8, () => 0],
    PeekConsoleInputA: [16, () => 0],
    ReadConsoleInputA: [16, () => 0],
    ReadConsoleA: [20, () => 0],
    WriteConsoleA: [20, (m, a) => {
      m.log(`console: ${m.mem.readCString(a.u(1), a.u(2))}`);
      if (a.u(3)) m.mem.dv.setUint32(a.u(3), a.u(2), true);
      return 1;
    }],
    Beep: [8, () => 1],

    // modules
    GetModuleHandleA: [4, (m, a) => {
      const name = a.str(0);
      if (name === null) return m.exe!.base;
      const mod = m.findModule(name);
      if (mod) return mod.base;
      if (m.isHleModule(name)) return m.loadModuleSync(name)!.base;
      setError(m, ERROR_MOD_NOT_FOUND);
      return 0;
    }],
    GetModuleHandleW: [4, (m, a) => {
      const name = a.wstr(0);
      if (name === null) return m.exe!.base;
      return m.findModule(name)?.base ?? 0;
    }],
    GetModuleFileNameA: [12, (m, a) => {
      const mod = a.u(0) ? m.modules.find((x) => x.base === a.u(0)) : m.exe;
      if (!mod) return 0;
      return putA(m, a.u(1), a.u(2), mod.path);
    }],
    GetModuleFileNameW: [12, (m, a) => {
      const mod = a.u(0) ? m.modules.find((x) => x.base === a.u(0)) : m.exe;
      if (!mod) return 0;
      return putW(m, a.u(1), a.u(2), mod.path);
    }],
    LoadLibraryA: [4, function* (m, a) {
      const name = a.str(0) ?? "";
      const r = yield* m.loadLibrary(name);
      if (!r) {
        m.log(`LoadLibrary(${name}) failed`);
        setError(m, ERROR_MOD_NOT_FOUND);
      }
      return r;
    }],
    LoadLibraryExA: [12, function* (m, a) {
      return yield* m.loadLibrary(a.str(0) ?? "");
    }],
    FreeLibrary: [4, () => 1],
    GetProcAddress: [8, (m, a) => {
      const mod = m.modules.find((x) => x.base === a.u(0));
      if (!mod) { setError(m, ERROR_INVALID_HANDLE); return 0; }
      const p = a.u(1);
      const addr = p < 0x10000 ? m.resolveExport(mod, null, p, false) : m.resolveExport(mod, m.mem.readCString(p), 0, false);
      if (!addr) {
        m.log(`GetProcAddress(${mod.name}, ${p < 0x10000 ? "#" + p : m.mem.readCString(p)}) -> NULL`);
        setError(m, ERROR_PROC_NOT_FOUND);
      }
      return addr;
    }],
    DisableThreadLibraryCalls: [4, () => 1],

    // memory
    VirtualAlloc: [16, (m, a) => {
      const addr = a.u(0), size = a.u(1), type = a.u(2);
      if (addr) {
        const r = m.as.find(addr);
        if (r) return type & 0x1000 ? addr & ~0xfff : 0;
        const base = addr & ~0xffff;
        if (!m.as.reserveAt(base, roundUp(size + (addr - base), 0x1000), "virtual")) return 0;
        m.mem.fill(base, roundUp(size + (addr - base), 0x1000), 0);
        return type & 0x2000 && !(type & 0x1000) ? base : addr & ~0xfff;
      }
      const base = m.as.reserve(size, "virtual", 0x10000, (type & 0x100000) !== 0);
      if (base) m.mem.fill(base, roundUp(size, 0x1000), 0);
      return base;
    }],
    VirtualFree: [12, (m, a) => {
      if (a.u(2) & 0x8000) return m.as.release(a.u(0)) ? 1 : 0;
      return 1;
    }],
    VirtualProtect: [16, (m, a) => {
      if (a.u(3)) m.mem.dv.setUint32(a.u(3), 4, true);
      m.cpu.invalidate(a.u(0), a.u(1));
      return 1;
    }],
    VirtualQuery: [12, (m, a) => {
      const r = m.as.find(a.u(0)), p = a.u(1), dv = m.mem.dv;
      if (!p) return 0;
      m.mem.u8.fill(0, p, p + 28);
      const page = a.u(0) & ~0xfff;
      dv.setUint32(p, page, true);
      dv.setUint32(p + 4, r ? r.base : page, true);
      dv.setUint32(p + 8, 4, true);
      dv.setUint32(p + 12, r ? r.base + r.size - page : 0x1000, true);
      dv.setUint32(p + 16, r ? 0x1000 : 0x10000, true);
      dv.setUint32(p + 20, 4, true);
      dv.setUint32(p + 24, 0x20000, true);
      return 28;
    }],
    HeapCreate: [12, (m) => m.createHeap("user").handle],
    HeapDestroy: [4, (m, a) => (m.heaps.delete(a.u(0)), 1)],
    HeapAlloc: [12, (m, a) => {
      const h = m.heaps.get(a.u(0)) ?? m.processHeap;
      const p = h.alloc(a.u(2), (a.u(1) & 8) !== 0);
      if (!p) m.log(`HeapAlloc(${a.u(2)}) failed`);
      return p;
    }],
    HeapFree: [12, (m, a) => {
      if (!a.u(2)) return 1;
      const h = m.heaps.get(a.u(0));
      if (h && h.free(a.u(2))) return 1;
      const other = m.heapOf(a.u(2));
      if (other) return other.free(a.u(2)) ? 1 : 0;
      m.log(`HeapFree of unknown block ${hex(a.u(2))}`);
      return 0;
    }],
    HeapReAlloc: [16, (m, a) => {
      const h = m.heaps.get(a.u(0)) ?? m.heapOf(a.u(2));
      if (!h) return 0;
      return h.realloc(a.u(2), a.u(3), (a.u(1) & 8) !== 0, (a.u(1) & 0x10) !== 0);
    }],
    HeapSize: [12, (m, a) => {
      const h = m.heaps.get(a.u(0)) ?? m.heapOf(a.u(2));
      return h ? h.size(a.u(2)) : 0xffffffff;
    }],
    HeapValidate: [12, () => 1],
    HeapCompact: [8, () => 0],
    HeapWalk: [8, (m) => { setError(m, ERROR_NO_MORE_ITEMS); return 0; }],
    GetProcessHeap: [0, (m) => m.processHeap.handle],
    GlobalAlloc: [8, (m, a) => m.processHeap.alloc(a.u(1), (a.u(0) & 0x40) !== 0)],
    GlobalLock: [4, (m, a) => a.u(0)],
    GlobalUnlock: [4, () => 1],
    GlobalHandle: [4, (m, a) => a.u(0)],
    GlobalFlags: [4, () => 0],
    GlobalSize: [4, (m, a) => Math.max(0, m.processHeap.size(a.u(0)))],
    GlobalFree: [4, (m, a) => (m.processHeap.free(a.u(0)), 0)],
    GlobalReAlloc: [12, (m, a) => m.processHeap.realloc(a.u(0), a.u(1), (a.u(2) & 0x40) !== 0, false)],
    LocalAlloc: [8, (m, a) => m.processHeap.alloc(a.u(1), (a.u(0) & 0x40) !== 0)],
    LocalLock: [4, (m, a) => a.u(0)],
    LocalUnlock: [4, () => 1],
    LocalFree: [4, (m, a) => (m.processHeap.free(a.u(0)), 0)],
    LocalReAlloc: [12, (m, a) => m.processHeap.realloc(a.u(0), a.u(1), (a.u(2) & 0x40) !== 0, false)],
    LocalSize: [4, (m, a) => Math.max(0, m.processHeap.size(a.u(0)))],
    GlobalMemoryStatus: [4, (m, a) => {
      const p = a.u(0), dv = m.mem.dv;
      const vals = [32, 30, 128 << 20, 96 << 20, 256 << 20, 200 << 20, 0x7ffe0000, 0x60000000];
      vals.forEach((v, i) => dv.setUint32(p + i * 4, v >>> 0, true));
    }],
    IsBadReadPtr: [8, (m, a) => (a.u(0) === 0 || a.u(0) + a.u(1) > m.mem.guestSize ? 1 : 0)],
    IsBadWritePtr: [8, (m, a) => (a.u(0) === 0 || a.u(0) + a.u(1) > m.mem.guestSize ? 1 : 0)],
    IsBadCodePtr: [4, (m, a) => (a.u(0) === 0 || a.u(0) > m.mem.guestSize ? 1 : 0)],
    IsBadStringPtrA: [8, (m, a) => (a.u(0) === 0 ? 1 : 0)],
    IsBadStringPtrW: [8, (m, a) => (a.u(0) === 0 ? 1 : 0)],

    // synchronization
    InitializeCriticalSection: [4, (m, a) => {
      m.mem.fill(a.u(0), 24, 0);
      m.mem.dv.setInt32(a.u(0) + 4, -1, true);
      (m.sub.cs ??= new Map()).set(a.u(0), new KMutex());
    }],
    DeleteCriticalSection: [4, (m, a) => { (m.sub.cs as Map<number, KMutex> | undefined)?.delete(a.u(0)); }],
    EnterCriticalSection: [4, function* (m, a) {
      const mu = csMutex(m, a.u(0));
      const t = m.cur!;
      if (mu.signaled(t)) mu.acquire(t);
      else yield* waitFor(m, [mu], false, 0xffffffff);
      m.mem.dv.setUint32(a.u(0) + 12, t.id, true);
      m.mem.dv.setInt32(a.u(0) + 8, mu.count, true);
    }],
    TryEnterCriticalSection: [4, (m, a) => {
      const mu = csMutex(m, a.u(0));
      if (!mu.signaled(m.cur!)) return 0;
      mu.acquire(m.cur!);
      return 1;
    }],
    LeaveCriticalSection: [4, (m, a) => {
      const mu = csMutex(m, a.u(0));
      mu.release(m.cur!);
      m.mem.dv.setInt32(a.u(0) + 8, mu.count, true);
      if (!mu.owner) m.mem.dv.setUint32(a.u(0) + 12, 0, true);
    }],
    InterlockedIncrement: [4, (m, a) => { const v = (m.mem.dv.getInt32(a.u(0), true) + 1) | 0; m.mem.dv.setInt32(a.u(0), v, true); return v; }],
    InterlockedDecrement: [4, (m, a) => { const v = (m.mem.dv.getInt32(a.u(0), true) - 1) | 0; m.mem.dv.setInt32(a.u(0), v, true); return v; }],
    InterlockedExchange: [8, (m, a) => { const v = m.mem.dv.getUint32(a.u(0), true); m.mem.dv.setUint32(a.u(0), a.u(1), true); return v; }],
    InterlockedCompareExchange: [12, (m, a) => {
      const v = m.mem.dv.getUint32(a.u(0), true);
      if (v === a.u(2)) m.mem.dv.setUint32(a.u(0), a.u(1), true);
      return v;
    }],
    CreateEventA: [16, (m, a) => {
      const name = a.str(3);
      if (name) {
        const ex = m.handles.findNamed(name);
        if (ex) { ex.refs++; setError(m, ERROR_ALREADY_EXISTS); return m.handles.add(ex); }
      }
      const e = new KEvent(a.u(1) !== 0, a.u(2) !== 0);
      e.name = name;
      setError(m, 0);
      return m.handles.add(e);
    }],
    SetEvent: [4, (m, a) => { const e = obj<KEvent>(m, a.u(0)); if (!e) return 0; e.state = true; return 1; }],
    ResetEvent: [4, (m, a) => { const e = obj<KEvent>(m, a.u(0)); if (!e) return 0; e.state = false; return 1; }],
    PulseEvent: [4, (m, a) => { const e = obj<KEvent>(m, a.u(0)); if (!e) return 0; e.state = true; m.sub.pulse = e; return 1; }],
    CreateMutexA: [12, (m, a) => {
      const name = a.str(2);
      if (name) {
        const ex = m.handles.findNamed(name);
        if (ex) { ex.refs++; setError(m, ERROR_ALREADY_EXISTS); return m.handles.add(ex); }
      }
      const mu = new KMutex();
      mu.name = name;
      if (a.u(1)) mu.acquire(m.cur!);
      setError(m, 0);
      return m.handles.add(mu);
    }],
    ReleaseMutex: [4, (m, a) => {
      const mu = obj<KMutex>(m, a.u(0));
      if (!mu || !mu.release(m.cur!)) { setError(m, ERROR_NOT_OWNER); return 0; }
      return 1;
    }],
    CreateSemaphoreA: [16, (m, a) => {
      const s = new KSemaphore(a.i(1), a.i(2));
      s.name = a.str(3);
      return m.handles.add(s);
    }],
    ReleaseSemaphore: [12, (m, a) => {
      const s = obj<KSemaphore>(m, a.u(0));
      if (!s) return 0;
      if (a.u(2)) m.mem.dv.setInt32(a.u(2), s.count, true);
      if (s.count + a.i(1) > s.max) { setError(m, 298); return 0; }
      s.count += a.i(1);
      return 1;
    }],
    WaitForSingleObject: [8, function* (m, a) {
      const o = obj(m, a.u(0));
      if (!o) { setError(m, ERROR_INVALID_HANDLE); return 0xffffffff; }
      const t = m.cur!;
      if (o.signaled(t)) { o.acquire(t); return 0; }
      if (a.u(1) === 0) return 0x102;
      return yield* waitFor(m, [o], false, a.u(1));
    }],
    WaitForMultipleObjects: [16, function* (m, a) {
      const n = a.u(0), objs: KObject[] = [];
      for (let i = 0; i < n; i++) {
        const o = obj(m, m.mem.dv.getUint32(a.u(1) + i * 4, true));
        if (!o) { setError(m, ERROR_INVALID_HANDLE); return 0xffffffff; }
        objs.push(o);
      }
      const t = m.cur!, all = a.u(2) !== 0;
      if (all ? objs.every((o) => o.signaled(t)) : objs.some((o) => o.signaled(t))) {
        if (all) { objs.forEach((o) => o.acquire(t)); return 0; }
        const i = objs.findIndex((o) => o.signaled(t));
        objs[i].acquire(t);
        return i;
      }
      if (a.u(3) === 0) return 0x102;
      return yield* waitFor(m, objs, all, a.u(3));
    }],
    Sleep: [4, function* (m, a) {
      const ms = a.u(0);
      if (ms === 0) { yield { t: "yield" }; return; }
      yield* waitFor(m, [], false, ms);
    }],
    SleepEx: [8, function* (m, a) {
      yield* waitFor(m, [], false, a.u(0));
      return 0;
    }],
    DuplicateHandle: [28, (m, a) => {
      const src = a.u(1);
      let h: number;
      if (src === 0xfffffffe) h = m.handles.add(m.cur!);
      else if (src === 0xffffffff) h = 0xffffffff;
      else h = m.handles.dup(src);
      if (a.u(3)) m.mem.dv.setUint32(a.u(3), h, true);
      return h ? 1 : 0;
    }],
    CloseHandle: [4, (m, a) => {
      const h = a.u(0);
      if (h === 0xffffffff || h === 0xfffffffe) return 1;
      if (!m.handles.close(h)) { setError(m, ERROR_INVALID_HANDLE); return 0; }
      return 1;
    }],

    // threads
    CreateThread: [24, (m, a) => {
      const t = m.createThread(a.u(1), a.u(2), a.u(3));
      if (a.u(4) & 4) t.suspend = 1;
      if (a.u(5)) m.mem.dv.setUint32(a.u(5), t.id, true);
      m.log(`CreateThread t${t.id} start=${m.symbolize(a.u(2))}`);
      return t.handle;
    }],
    ExitThread: [4, (m, a) => { m.exitThread(m.cur!, a.u(0)); }],
    TerminateThread: [8, (m, a) => {
      const t = obj<Thread>(m, a.u(0));
      if (!t || t.kind !== "thread") return 0;
      m.exitThread(t, a.u(1));
      return 1;
    }],
    SuspendThread: [4, (m, a) => {
      const t = obj<Thread>(m, a.u(0));
      if (!t || t.kind !== "thread") return 0xffffffff;
      const prev = t.suspend++;
      if (t === m.cur) m.cpu.stopReq = true;
      return prev;
    }],
    ResumeThread: [4, (m, a) => {
      const t = obj<Thread>(m, a.u(0));
      if (!t || t.kind !== "thread") return 0xffffffff;
      const prev = t.suspend;
      if (t.suspend > 0) t.suspend--;
      return prev;
    }],
    SetThreadPriority: [8, (m, a) => {
      const t = obj<Thread>(m, a.u(0));
      if (t && t.kind === "thread") t.priority = a.i(1);
      return 1;
    }],
    GetThreadPriority: [4, (m, a) => obj<Thread>(m, a.u(0))?.priority ?? 0],
    GetExitCodeThread: [8, (m, a) => {
      const t = obj<Thread>(m, a.u(0));
      if (!t) return 0;
      m.mem.dv.setUint32(a.u(1), t.exitCode, true);
      return 1;
    }],
    SetPriorityClass: [8, () => 1],
    GetPriorityClass: [4, () => 0x20],
    TlsAlloc: [0, (m) => {
      const used: boolean[] = (m.sub.tlsUsed ??= []);
      let i = used.indexOf(false);
      if (i < 0) i = used.length;
      used[i] = true;
      return i;
    }],
    TlsFree: [4, (m, a) => { (m.sub.tlsUsed ??= [])[a.u(0)] = false; return 1; }],
    TlsGetValue: [4, (m, a) => { setError(m, 0); return m.cur!.tls[a.u(0)] ?? 0; }],
    TlsSetValue: [8, (m, a) => { m.cur!.tls[a.u(0)] = a.u(1); return 1; }],

    // errors
    GetLastError: [0, (m) => m.cur!.lastError],
    SetLastError: [4, (m, a) => { m.cur!.lastError = a.u(0); }],
    SetLastErrorEx: [8, (m, a) => { m.cur!.lastError = a.u(0); }],
    FormatMessageA: [28, (m, a) => {
      const flags = a.u(0), code = a.u(2);
      const s = `Error ${code}\r\n`;
      if (flags & 0x100) {
        const p = m.processHeap.alloc(s.length + 1, false);
        m.mem.writeCString(p, s);
        m.mem.dv.setUint32(a.u(4), p, true);
        return s.length;
      }
      return putA(m, a.u(4), a.u(5), s);
    }],

    // files
    CreateFileA: [28, (m, a) => openFile(m, a.str(0), a.u(1), a.u(4), a.u(5))],
    CreateFileW: [28, (m, a) => openFile(m, a.wstr(0), a.u(1), a.u(4), a.u(5))],
    ReadFile: [20, (m, a) => {
      const f = obj<KFile>(m, a.u(0));
      if (!f || f.kind !== "file") { setError(m, ERROR_INVALID_HANDLE); return 0; }
      const n = f.node.read(f.pos, m.mem.u8, a.u(1), Math.min(a.u(2), m.mem.guestSize - a.u(1)));
      f.pos += n;
      if (a.u(3)) m.mem.dv.setUint32(a.u(3), n, true);
      return 1;
    }],
    WriteFile: [20, (m, a) => {
      const o = obj(m, a.u(0));
      if (o && o.kind === "console") {
        const c = o as KConsole;
        c.buf += m.mem.readCString(a.u(1), a.u(2)).slice(0, a.u(2));
        let nl: number;
        while ((nl = c.buf.indexOf("\n")) >= 0) {
          m.log(`stdout: ${c.buf.slice(0, nl).replace(/\r$/, "")}`);
          c.buf = c.buf.slice(nl + 1);
        }
        if (a.u(3)) m.mem.dv.setUint32(a.u(3), a.u(2), true);
        return 1;
      }
      const f = o as KFile | undefined;
      if (!f || f.kind !== "file") { setError(m, ERROR_INVALID_HANDLE); return 0; }
      if (!f.canWrite) { setError(m, ERROR_ACCESS_DENIED); return 0; }
      const n = f.node.write(f.pos, m.mem.u8.subarray(a.u(1), a.u(1) + a.u(2)));
      f.pos += n;
      f.dirty = true;
      if (a.u(3)) m.mem.dv.setUint32(a.u(3), n, true);
      return 1;
    }],
    SetFilePointer: [16, (m, a) => {
      const f = obj<KFile>(m, a.u(0));
      if (!f || f.kind !== "file") { setError(m, ERROR_INVALID_HANDLE); return INVALID; }
      let dist = a.i(1);
      if (a.u(2)) dist += m.mem.dv.getInt32(a.u(2), true) * 4294967296;
      const base = a.u(3) === 0 ? 0 : a.u(3) === 1 ? f.pos : f.node.length;
      const np = base + dist;
      if (np < 0) { setError(m, 131); return INVALID; }
      f.pos = np;
      if (a.u(2)) m.mem.dv.setUint32(a.u(2), Math.floor(np / 4294967296), true);
      setError(m, 0);
      return np >>> 0;
    }],
    SetEndOfFile: [4, (m, a) => {
      const f = obj<KFile>(m, a.u(0));
      if (!f) return 0;
      f.node.truncate(f.pos);
      f.dirty = true;
      return 1;
    }],
    FlushFileBuffers: [4, (m, a) => {
      const f = obj<KFile>(m, a.u(0));
      if (f && f.kind === "file" && f.dirty) { m.vfs.flush(f.node); f.dirty = false; }
      return 1;
    }],
    GetFileSize: [8, (m, a) => {
      const f = obj<KFile>(m, a.u(0));
      if (!f || f.kind !== "file") { setError(m, ERROR_INVALID_HANDLE); return INVALID; }
      if (a.u(1)) m.mem.dv.setUint32(a.u(1), 0, true);
      return f.node.length;
    }],
    GetFileTime: [16, (m, a) => {
      const f = obj<KFile>(m, a.u(0));
      if (!f) return 0;
      writeFileTime(m, a.u(1), f.node.mtime);
      writeFileTime(m, a.u(2), f.node.mtime);
      writeFileTime(m, a.u(3), f.node.mtime);
      return 1;
    }],
    SetFileTime: [16, (m, a) => {
      const f = obj<KFile>(m, a.u(0));
      if (f && a.u(3)) f.node.mtime = msFromFileTime(m.mem.dv.getUint32(a.u(3), true), m.mem.dv.getUint32(a.u(3) + 4, true));
      return 1;
    }],
    GetFileInformationByHandle: [8, (m, a) => {
      const f = obj<KFile>(m, a.u(0));
      if (!f) return 0;
      const p = a.u(1), dv = m.mem.dv;
      m.mem.u8.fill(0, p, p + 52);
      dv.setUint32(p, attrsOf(f.node), true);
      writeFileTime(m, p + 4, f.node.mtime);
      writeFileTime(m, p + 12, f.node.mtime);
      writeFileTime(m, p + 20, f.node.mtime);
      dv.setUint32(p + 28, 0x1234, true);
      dv.setUint32(p + 36, f.node.length, true);
      dv.setUint32(p + 40, 1, true);
      return 1;
    }],
    LockFile: [20, () => 1],
    UnlockFile: [20, () => 1],
    DeleteFileA: [4, (m, a) => (m.vfs.remove(a.str(0) ?? "") ? 1 : (setError(m, ERROR_FILE_NOT_FOUND), 0))],
    DeleteFileW: [4, (m, a) => (m.vfs.remove(a.wstr(0) ?? "") ? 1 : (setError(m, ERROR_FILE_NOT_FOUND), 0))],
    CopyFileA: [12, (m, a) => {
      const src = m.vfs.lookup(a.str(0) ?? "");
      if (!src || src.isDir) { setError(m, ERROR_FILE_NOT_FOUND); return 0; }
      if (a.u(2) && m.vfs.lookup(a.str(1) ?? "")) { setError(m, ERROR_FILE_EXISTS); return 0; }
      const dst = m.vfs.create(a.str(1) ?? "");
      if (!dst) { setError(m, ERROR_PATH_NOT_FOUND); return 0; }
      const buf = new Uint8Array(src.length);
      src.read(0, buf, 0, buf.length);
      dst.write(0, buf);
      m.vfs.flush(dst);
      return 1;
    }],
    MoveFileA: [8, (m, a) => (m.vfs.rename(a.str(0) ?? "", a.str(1) ?? "") ? 1 : 0)],
    MoveFileW: [8, (m, a) => (m.vfs.rename(a.wstr(0) ?? "", a.wstr(1) ?? "") ? 1 : 0)],
    CreateDirectoryA: [8, (m, a) => {
      const p = a.str(0) ?? "";
      if (m.vfs.lookup(p)) { setError(m, ERROR_ALREADY_EXISTS); return 0; }
      if (!m.vfs.parentOf(p)) { setError(m, ERROR_PATH_NOT_FOUND); return 0; }
      m.vfs.mkdirp(p);
      return 1;
    }],
    CreateDirectoryW: [8, (m, a) => {
      const p = a.wstr(0) ?? "";
      if (m.vfs.lookup(p)) { setError(m, ERROR_ALREADY_EXISTS); return 0; }
      m.vfs.mkdirp(p);
      return 1;
    }],
    RemoveDirectoryA: [4, (m, a) => (m.vfs.remove(a.str(0) ?? "") ? 1 : 0)],
    RemoveDirectoryW: [4, (m, a) => (m.vfs.remove(a.wstr(0) ?? "") ? 1 : 0)],
    GetFileAttributesA: [4, (m, a) => fileAttributes(m, a.str(0))],
    GetFileAttributesW: [4, (m, a) => fileAttributes(m, a.wstr(0))],
    SetFileAttributesA: [8, (m, a) => {
      const n = m.vfs.lookup(a.str(0) ?? "");
      if (!n) return 0;
      n.readonly = (a.u(1) & 1) !== 0;
      n.attrs = a.u(1) & ~1;
      return 1;
    }],
    SetFileAttributesW: [8, () => 1],
    FindFirstFileA: [8, (m, a) => findFirst(m, a.str(0), a.u(1), false)],
    FindFirstFileW: [8, (m, a) => findFirst(m, a.wstr(0), a.u(1), true)],
    FindNextFileA: [8, (m, a) => {
      const f = obj<KFind>(m, a.u(0));
      if (!f || f.idx >= f.entries.length) { setError(m, ERROR_NO_MORE_FILES); return 0; }
      writeFindData(m, a.u(1), f.entries[f.idx++], false);
      return 1;
    }],
    FindNextFileW: [8, (m, a) => {
      const f = obj<KFind>(m, a.u(0));
      if (!f || f.idx >= f.entries.length) { setError(m, ERROR_NO_MORE_FILES); return 0; }
      writeFindData(m, a.u(1), f.entries[f.idx++], true);
      return 1;
    }],
    FindClose: [4, (m, a) => (m.handles.close(a.u(0)) ? 1 : 0)],
    GetFullPathNameA: [16, (m, a) => {
      const full = m.vfs.full(a.str(0) ?? "") ?? "";
      if (a.u(1) <= full.length) return full.length + 1;
      putA(m, a.u(2), a.u(1), full);
      if (a.u(3)) m.mem.dv.setUint32(a.u(3), a.u(2) + full.lastIndexOf("\\") + 1, true);
      return full.length;
    }],
    GetFullPathNameW: [16, (m, a) => {
      const full = m.vfs.full(a.wstr(0) ?? "") ?? "";
      if (a.u(1) <= full.length) return full.length + 1;
      putW(m, a.u(2), a.u(1), full);
      if (a.u(3)) m.mem.dv.setUint32(a.u(3), a.u(2) + (full.lastIndexOf("\\") + 1) * 2, true);
      return full.length;
    }],
    GetShortPathNameA: [12, (m, a) => {
      const s = a.str(0) ?? "";
      if (a.u(2) <= s.length) return s.length + 1;
      return putA(m, a.u(1), a.u(2), s);
    }],
    SearchPathA: [24, (m, a) => {
      const name = a.str(1) ?? "", ext = a.str(2) ?? "";
      const dirs = a.str(0) ? [a.str(0)!] : [m.exe ? m.exe.path.replace(/\\[^\\]*$/, "") : "C:\\", m.vfs.cwd, m.systemDir, m.windowsDir];
      for (const d of dirs) {
        for (const cand of [`${d}\\${name}`, `${d}\\${name}${ext}`]) {
          const full = m.vfs.full(cand);
          if (full && m.vfs.lookup(full)) {
            putA(m, a.u(4), a.u(3), full);
            if (a.u(5)) m.mem.dv.setUint32(a.u(5), a.u(4) + full.lastIndexOf("\\") + 1, true);
            return full.length;
          }
        }
      }
      setError(m, ERROR_FILE_NOT_FOUND);
      return 0;
    }],
    GetTempPathA: [8, (m, a) => {
      m.vfs.mkdirp(`${m.windowsDir}\\TEMP`);
      return putA(m, a.u(1), a.u(0), `${m.windowsDir}\\TEMP\\`);
    }],
    GetTempFileNameA: [16, (m, a) => {
      const n = (m.sub.tmpCounter = (m.sub.tmpCounter ?? 0) + 1);
      const name = `${a.str(0)}\\${(a.str(1) ?? "").slice(0, 3)}${n.toString(16).toUpperCase()}.TMP`.replace(/\\\\/g, "\\");
      putA(m, a.u(3), 260, name);
      if (!a.u(2)) m.vfs.create(name);
      return n;
    }],
    GetCurrentDirectoryA: [8, (m, a) => {
      if (a.u(0) <= m.vfs.cwd.length) return m.vfs.cwd.length + 1;
      return putA(m, a.u(1), a.u(0), m.vfs.cwd);
    }],
    GetCurrentDirectoryW: [8, (m, a) => {
      if (a.u(0) <= m.vfs.cwd.length) return m.vfs.cwd.length + 1;
      return putW(m, a.u(1), a.u(0), m.vfs.cwd);
    }],
    SetCurrentDirectoryA: [4, (m, a) => {
      const full = m.vfs.full(a.str(0) ?? "");
      const n = full && m.vfs.lookup(full);
      if (!n || !n.isDir) { setError(m, ERROR_PATH_NOT_FOUND); return 0; }
      m.vfs.cwd = full!;
      return 1;
    }],
    SetCurrentDirectoryW: [4, (m, a) => {
      const full = m.vfs.full(a.wstr(0) ?? "");
      const n = full && m.vfs.lookup(full);
      if (!n || !n.isDir) return 0;
      m.vfs.cwd = full!;
      return 1;
    }],
    GetDriveTypeA: [4, (m, a) => {
      const p = a.str(0);
      const info = m.vfs.driveOf(p ?? m.vfs.cwd);
      return info ? info.type : 1;
    }],
    GetDriveTypeW: [4, (m, a) => m.vfs.driveOf(a.wstr(0) ?? m.vfs.cwd)?.type ?? 1],
    GetLogicalDrives: [0, (m) => {
      let mask = 0;
      for (const l of m.vfs.drives.keys()) mask |= 1 << (l.charCodeAt(0) - 65);
      return mask;
    }],
    GetLogicalDriveStringsA: [8, (m, a) => {
      const s = [...m.vfs.drives.keys()].sort().map((l) => `${l}:\\\0`).join("");
      if (a.u(0) < s.length + 1) return s.length + 1;
      for (let i = 0; i < s.length; i++) m.mem.u8[a.u(1) + i] = s.charCodeAt(i);
      m.mem.u8[a.u(1) + s.length] = 0;
      return s.length;
    }],
    GetVolumeInformationA: [32, (m, a) => {
      const info = m.vfs.driveOf(a.str(0) ?? m.vfs.cwd);
      if (!info) { setError(m, 21); return 0; }
      putA(m, a.u(1), a.u(2), info.label);
      if (a.u(3)) m.mem.dv.setUint32(a.u(3), info.serial, true);
      if (a.u(4)) m.mem.dv.setUint32(a.u(4), 255, true);
      if (a.u(5)) m.mem.dv.setUint32(a.u(5), info.type === DRIVE_CDROM ? 0x80005 : 0x3, true);
      putA(m, a.u(6), a.u(7), info.fs);
      return 1;
    }],
    GetDiskFreeSpaceA: [20, (m, a) => {
      const dv = m.mem.dv;
      [8, 512, 0x40000, 0x80000].forEach((v, i) => a.u(1 + i) && dv.setUint32(a.u(1 + i), v, true));
      return 1;
    }],
    GetWindowsDirectoryA: [8, (m, a) => putA(m, a.u(0), a.u(1), m.windowsDir)],
    GetSystemDirectoryA: [8, (m, a) => putA(m, a.u(0), a.u(1), m.systemDir)],

    // time
    GetTickCount: [0, (m) => Math.floor(m.now() - m.startTime + 3600000) >>> 0],
    QueryPerformanceFrequency: [4, (m, a) => {
      m.mem.dv.setUint32(a.u(0), 1000000, true);
      m.mem.dv.setUint32(a.u(0) + 4, 0, true);
      return 1;
    }],
    QueryPerformanceCounter: [4, (m, a) => {
      const us = Math.floor((m.now() - m.startTime) * 1000) + 1e9;
      m.mem.dv.setUint32(a.u(0), us % 4294967296, true);
      m.mem.dv.setUint32(a.u(0) + 4, Math.floor(us / 4294967296), true);
      return 1;
    }],
    GetLocalTime: [4, (m, a) => writeSystemTime(m, a.u(0), new Date(), false)],
    GetSystemTime: [4, (m, a) => writeSystemTime(m, a.u(0), new Date(), true)],
    SetLocalTime: [4, () => 1],
    GetSystemTimeAsFileTime: [4, (m, a) => writeFileTime(m, a.u(0), Date.now())],
    GetTimeZoneInformation: [4, (m, a) => { m.mem.fill(a.u(0), 172, 0); return 0; }],
    FileTimeToLocalFileTime: [8, (m, a) => {
      m.mem.dv.setUint32(a.u(1), m.mem.dv.getUint32(a.u(0), true), true);
      m.mem.dv.setUint32(a.u(1) + 4, m.mem.dv.getUint32(a.u(0) + 4, true), true);
      return 1;
    }],
    LocalFileTimeToFileTime: [8, (m, a) => {
      m.mem.dv.setUint32(a.u(1), m.mem.dv.getUint32(a.u(0), true), true);
      m.mem.dv.setUint32(a.u(1) + 4, m.mem.dv.getUint32(a.u(0) + 4, true), true);
      return 1;
    }],
    FileTimeToSystemTime: [8, (m, a) => {
      const ms = msFromFileTime(m.mem.dv.getUint32(a.u(0), true), m.mem.dv.getUint32(a.u(0) + 4, true));
      writeSystemTime(m, a.u(1), new Date(ms), true);
      return 1;
    }],
    SystemTimeToFileTime: [8, (m, a) => {
      const dv = m.mem.dv, p = a.u(0);
      const g = (i: number) => dv.getUint16(p + i * 2, true);
      const ms = Date.UTC(g(0), g(1) - 1, g(3), g(4), g(5), g(6), g(7));
      writeFileTime(m, a.u(1), ms);
      return 1;
    }],

    // strings & locale
    lstrlenA: [4, (m, a) => (a.u(0) ? m.mem.readCString(a.u(0)).length : 0)],
    lstrlenW: [4, (m, a) => (a.u(0) ? m.mem.readWString(a.u(0)).length : 0)],
    lstrcpyA: [8, (m, a) => { m.mem.writeCString(a.u(0), a.str(1) ?? ""); return a.u(0); }],
    lstrcpyW: [8, (m, a) => { m.mem.writeWString(a.u(0), a.wstr(1) ?? ""); return a.u(0); }],
    lstrcpynA: [12, (m, a) => { putA(m, a.u(0), a.u(2), a.str(1) ?? ""); return a.u(0); }],
    lstrcatA: [8, (m, a) => { m.mem.writeCString(a.u(0), (a.str(0) ?? "") + (a.str(1) ?? "")); return a.u(0); }],
    lstrcmpA: [8, (m, a) => cmp(a.str(0) ?? "", a.str(1) ?? "")],
    lstrcmpiA: [8, (m, a) => cmp((a.str(0) ?? "").toLowerCase(), (a.str(1) ?? "").toLowerCase())],
    CompareStringA: [24, (m, a) => {
      let s1 = m.mem.readCString(a.u(2), a.i(3) < 0 ? 0x10000 : a.u(3)).slice(0, a.i(3) < 0 ? undefined : a.u(3));
      let s2 = m.mem.readCString(a.u(4), a.i(5) < 0 ? 0x10000 : a.u(5)).slice(0, a.i(5) < 0 ? undefined : a.u(5));
      if (a.u(1) & 1) { s1 = s1.toLowerCase(); s2 = s2.toLowerCase(); }
      return cmp(s1, s2) + 2;
    }],
    CompareStringW: [24, (m, a) => {
      const rd = (p: number, n: number) => (n < 0 ? m.mem.readWString(p) : m.mem.readWString(p, n).slice(0, n));
      let s1 = rd(a.u(2), a.i(3)), s2 = rd(a.u(4), a.i(5));
      if (a.u(1) & 1) { s1 = s1.toLowerCase(); s2 = s2.toLowerCase(); }
      return cmp(s1, s2) + 2;
    }],
    LCMapStringA: [24, (m, a) => {
      const n = a.i(3) < 0 ? m.mem.readCString(a.u(2)).length + 1 : a.u(3);
      if (!a.u(5)) return n;
      for (let i = 0; i < Math.min(n, a.u(5)); i++) {
        let c = m.mem.u8[a.u(2) + i];
        if (a.u(1) & 0x200) c = upper(c);
        else if (a.u(1) & 0x100) c = lower(c);
        m.mem.u8[a.u(4) + i] = c;
      }
      return Math.min(n, a.u(5));
    }],
    LCMapStringW: [24, (m, a) => {
      const n = a.i(3) < 0 ? m.mem.readWString(a.u(2)).length + 1 : a.u(3);
      if (!a.u(5)) return n;
      for (let i = 0; i < Math.min(n, a.u(5)); i++) {
        let s = String.fromCharCode(m.mem.dv.getUint16(a.u(2) + i * 2, true));
        if (a.u(1) & 0x200) s = s.toUpperCase();
        else if (a.u(1) & 0x100) s = s.toLowerCase();
        m.mem.dv.setUint16(a.u(4) + i * 2, s.charCodeAt(0), true);
      }
      return Math.min(n, a.u(5));
    }],
    GetStringTypeA: [20, (m, a) => stringType(m, a.u(2), a.i(3), a.u(4), false)],
    GetStringTypeExA: [20, (m, a) => stringType(m, a.u(2), a.i(3), a.u(4), false)],
    GetStringTypeW: [16, (m, a) => stringType(m, a.u(1), a.i(2), a.u(3), true)],
    MultiByteToWideChar: [24, (m, a) => {
      const src = a.u(2), n = a.i(3) < 0 ? m.mem.readCString(src).length + 1 : a.u(3);
      if (!a.u(5)) return n;
      if (a.u(5) < n) { setError(m, ERROR_INSUFFICIENT_BUFFER); return 0; }
      for (let i = 0; i < n; i++) m.mem.dv.setUint16(a.u(4) + i * 2, cp1252(m.mem.u8[src + i]), true);
      return n;
    }],
    WideCharToMultiByte: [32, (m, a) => {
      const src = a.u(2), n = a.i(3) < 0 ? m.mem.readWString(src).length + 1 : a.u(3);
      if (!a.u(5)) return n;
      if (a.u(5) < n) { setError(m, ERROR_INSUFFICIENT_BUFFER); return 0; }
      for (let i = 0; i < n; i++) {
        const c = m.mem.dv.getUint16(src + i * 2, true);
        m.mem.u8[a.u(4) + i] = c < 256 ? c : 0x3f;
      }
      return n;
    }],
    GetACP: [0, () => 1252],
    GetOEMCP: [0, () => 437],
    GetCPInfo: [8, (m, a) => {
      const p = a.u(1);
      m.mem.fill(p, 20, 0);
      m.mem.dv.setUint32(p, 1, true);
      m.mem.u8[p + 4] = 0x3f;
      return 1;
    }],
    IsValidCodePage: [4, (m, a) => ([1252, 437, 850].includes(a.u(0)) ? 1 : 0)],
    IsDBCSLeadByte: [4, () => 0],
    GetUserDefaultLCID: [0, () => 0x409],
    GetSystemDefaultLCID: [0, () => 0x409],
    GetUserDefaultLangID: [0, () => 0x409],
    GetSystemDefaultLangID: [0, () => 0x409],
    GetThreadLocale: [0, () => 0x409],
    IsValidLocale: [8, () => 1],
    EnumSystemLocalesA: [8, () => 1],
    GetLocaleInfoA: [16, (m, a) => {
      const s = localeInfo(a.u(1));
      if (!a.u(3)) return s.length + 1;
      return putA(m, a.u(2), a.u(3), s) + 1;
    }],
    GetLocaleInfoW: [16, (m, a) => {
      const s = localeInfo(a.u(1));
      if (!a.u(3)) return s.length + 1;
      return putW(m, a.u(2), a.u(3), s) + 1;
    }],
    MulDiv: [12, (m, a) => (a.i(2) === 0 ? -1 : Math.round((a.i(0) * a.i(1)) / a.i(2)) | 0)],
    GlobalAddAtomA: [4, (m, a) => addAtom(m, a.u(0))],
    AddAtomA: [4, (m, a) => addAtom(m, a.u(0))],
    GlobalDeleteAtom: [4, () => 0],
    GlobalFindAtomA: [4, (m, a) => {
      const atoms: string[] = (m.sub.atoms ??= []);
      const i = atoms.indexOf((a.str(0) ?? "").toLowerCase());
      return i < 0 ? 0 : 0xc000 + i;
    }],
    GlobalGetAtomNameA: [12, (m, a) => {
      const atoms: string[] = (m.sub.atoms ??= []);
      const name = m.sub.atomNames?.[a.u(0) - 0xc000] ?? atoms[a.u(0) - 0xc000] ?? "";
      return putA(m, a.u(1), a.u(2), name);
    }],

    // ini files
    GetPrivateProfileStringA: [24, (m, a) => profileString(m, a.str(5) ?? "win.ini", a.u(0), a.u(1), a.str(2) ?? "", a.u(3), a.u(4))],
    GetProfileStringA: [20, (m, a) => profileString(m, "win.ini", a.u(0), a.u(1), a.str(2) ?? "", a.u(3), a.u(4))],
    GetPrivateProfileIntA: [16, (m, a) => profileInt(m, a.str(3) ?? "win.ini", a.str(0), a.str(1), a.i(2))],
    GetProfileIntA: [12, (m, a) => profileInt(m, "win.ini", a.str(0), a.str(1), a.i(2))],
    WritePrivateProfileStringA: [16, (m, a) => {
      const node = iniNode(m, a.str(3) ?? "win.ini", true)!;
      const text = readText(node);
      const out = iniSet(text, a.str(0) ?? "", a.str(1), a.str(2));
      node.truncate(0);
      node.write(0, latin1(out));
      m.vfs.flush(node);
      return 1;
    }],
    WriteProfileStringA: [12, () => 1],

    // resources
    FindResourceA: [12, (m, a) => {
      const mod = a.u(0) ? m.modules.find((x) => x.base === a.u(0)) : m.exe;
      if (!mod) return 0;
      return findResource(m, mod, a.u(2), a.u(1));
    }],
    LoadResource: [8, (m, a) => (a.u(1) ? m.mem.dv.getUint32(a.u(1), true) + (m.modules.find((x) => x.base === a.u(0)) ?? m.exe!).base : 0)],
    LockResource: [4, (m, a) => a.u(0)],
    FreeResource: [4, () => 0],
    SizeofResource: [8, (m, a) => (a.u(1) ? m.mem.dv.getUint32(a.u(1) + 4, true) : 0)],

    // exceptions
    RaiseException: [16, (m, a) => {
      const code = a.u(0), flags = a.u(1), n = Math.min(a.u(2), 15);
      const params: number[] = [];
      for (let i = 0; i < n; i++) params.push(m.mem.dv.getUint32(a.u(3) + i * 4, true));
      const ret = m.mem.dv.getUint32(a.base - 4, true);
      m.cpu.r[ESP] = a.base + 16;
      m.cpu.eip = ret;
      m.tookOver = true;
      m.raise(m.cur!, code, flags, ret, params);
    }],
    RtlUnwind: [16, function* (m, a) {
      const target = a.u(0), dv = m.mem.dv;
      const teb = m.cur!.teb;
      let reg = dv.getUint32(teb, true);
      const rec = a.u(2) || m.sysAlloc(0x50);
      dv.setUint32(rec + 4, dv.getUint32(rec + 4, true) | 2, true);
      while (reg !== 0xffffffff && reg !== target && reg !== 0) {
        const handler = dv.getUint32(reg + 4, true);
        const scratch: number = (m.sub.unwindScratch ??= m.sysAlloc(0x400, 16));
        yield { t: "call", addr: handler, args: [rec, reg, scratch, scratch + 0x300] };
        reg = dv.getUint32(reg, true);
        dv.setUint32(teb, reg, true);
      }
      return a.u(3);
    }],
  };
  m0.register("kernel32.dll", k);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function upper(c: number): number {
  return (c >= 97 && c <= 122) || (c >= 0xe0 && c <= 0xfe && c !== 0xf7) ? c - 32 : c;
}
function lower(c: number): number {
  return (c >= 65 && c <= 90) || (c >= 0xc0 && c <= 0xde && c !== 0xd7) ? c + 32 : c;
}
const CP1252_HI = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d,
  0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178];
export function cp1252(b: number): number {
  return b >= 0x80 && b < 0xa0 ? CP1252_HI[b - 0x80] : b;
}

function stringType(m: Machine, src: number, n: number, out: number, wide: boolean): number {
  if (n < 0) n = wide ? m.mem.readWString(src).length + 1 : m.mem.readCString(src).length + 1;
  for (let i = 0; i < n; i++) {
    const c = wide ? m.mem.dv.getUint16(src + i * 2, true) : m.mem.u8[src + i];
    let t = 0;
    const ch = String.fromCharCode(c);
    if (ch >= "A" && ch <= "Z") t |= 0x1 | 0x100;
    if (ch >= "a" && ch <= "z") t |= 0x2 | 0x100;
    if (ch >= "0" && ch <= "9") t |= 0x4;
    if (" \t\n\r\v\f".includes(ch)) t |= 0x8;
    if (c === 32 || c === 9) t |= 0x40;
    if (c < 32 || c === 127) t |= 0x20;
    if ((c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126)) t |= 0x10;
    if ((ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F")) t |= 0x80;
    if (c >= 0xc0 && c !== 0xd7 && c !== 0xf7) t |= 0x100 | (c < 0xe0 ? 1 : 2);
    if (c === 0) t = 0x20;
    m.mem.dv.setUint16(out + i * 2, t, true);
  }
  return 1;
}

function localeInfo(type: number): string {
  switch (type & 0xffff) {
    case 0x1: return "0409";
    case 0x2: return "English (United States)";
    case 0x3: return "ENU";
    case 0x4: return "English";
    case 0x5: return "1";
    case 0x6: return "United States";
    case 0x7: return "USA";
    case 0xb: return "437";
    case 0xc: return ",";
    case 0xe: return ".";
    case 0xf: return ",";
    case 0x14: return "$";
    case 0x1004: return "1252";
    case 0x1009: return "1";
    case 0x1d: return "/";
    case 0x1e: return ":";
    case 0x1f: return "M/d/yyyy";
    default: return "";
  }
}

function addAtom(m: Machine, p: number): number {
  if (p < 0x10000) return p;
  const atoms: string[] = (m.sub.atoms ??= []);
  const names: string[] = (m.sub.atomNames ??= []);
  const s = m.mem.readCString(p);
  let i = atoms.indexOf(s.toLowerCase());
  if (i < 0) {
    i = atoms.length;
    atoms.push(s.toLowerCase());
    names.push(s);
  }
  return 0xc000 + i;
}

export function latin1(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
}
function readText(n: VNode): string {
  const buf = new Uint8Array(n.length);
  n.read(0, buf, 0, buf.length);
  let s = "";
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
  return s;
}
function iniNode(m: Machine, file: string, create: boolean): VNode | null {
  const path = /[\\/:]/.test(file) ? file : `${m.windowsDir}\\${file}`;
  let n = m.vfs.lookup(path);
  if (!n && create) n = m.vfs.create(path);
  return n && !n.isDir ? n : null;
}
function profileString(m: Machine, file: string, secPtr: number, keyPtr: number, def: string, buf: number, size: number): number {
  const node = iniNode(m, file, false);
  const text = node ? readText(node) : "";
  const sec = secPtr ? m.mem.readCString(secPtr) : null;
  const key = keyPtr ? m.mem.readCString(keyPtr) : null;
  const r = iniGet(text, sec, key);
  let out: string;
  if (sec === null || key === null) {
    const list = (r as string[] | null) ?? [];
    out = list.join("\0") + (list.length ? "\0" : "");
    const n = Math.min(out.length, Math.max(0, size - 1));
    for (let i = 0; i < n; i++) m.mem.u8[buf + i] = out.charCodeAt(i);
    m.mem.u8[buf + n] = 0;
    return Math.max(0, n - (n === out.length ? 1 : 0));
  }
  out = (r as string | null) ?? def;
  if (m.trace) m.log(`ini ${file} [${sec}] ${key} = ${JSON.stringify(out)}`);
  return putA(m, buf, size, out);
}
function profileInt(m: Machine, file: string, sec: string | null, key: string | null, def: number): number {
  const node = iniNode(m, file, false);
  const v = node && sec && key ? (iniGet(readText(node), sec, key) as string | null) : null;
  if (v === null) return def;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? 0 : n;
}

export { DRIVE_FIXED };
void (ERROR_INVALID_PARAMETER as number);
void (baseName as unknown);
export type { GuestModule };
