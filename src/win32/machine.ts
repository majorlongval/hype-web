import { Memory } from "../cpu/memory";
import { CPU, ESP, EAX, GuestFault } from "../cpu/cpu";
import { AddressSpace, Heap, roundUp } from "./mm";
import { parsePe, mapImage, type PeFile } from "./pe";
import { HandleTable, KObject } from "./objects";
import { Thread, type Frame, type HleGen, type Req } from "./thread";
import { VFS } from "./vfs";

export const GUEST_SIZE = 0x20000000;
export const HLE_BASE = 0x1ff00000;
export const HLE_SLOTS = 0x10000;
export const HLE_MODBASE = 0x1fc00000;
export const SYS_BASE = 0x00010000;
export const SYS_END = 0x00400000;

const RET_THUNK = 0, EXIT_THUNK = 1;
export const STATUS_ACCESS_VIOLATION = 0xc0000005, STATUS_INT_DIVIDE = 0xc0000094, STATUS_BREAKPOINT = 0x80000003;
export const STATUS_ILLEGAL_INSN = 0xc000001d, STATUS_PRIV_INSN = 0xc0000096;

export type Impl = (m: Machine, a: Args) => number | void | HleGen;
export interface HleFn {
  mod: string;
  name: string;
  pop: number;
  impl: Impl | null;
  index: number;
  calls: number;
}

export class Args {
  constructor(
    private m: Machine,
    public base: number,
  ) {}
  u(i: number): number {
    return this.m.mem.dv.getUint32(this.base + i * 4, true);
  }
  i(i: number): number {
    return this.m.mem.dv.getInt32(this.base + i * 4, true);
  }
  f64(i: number): number {
    return this.m.mem.dv.getFloat64(this.base + i * 4, true);
  }
  f32(i: number): number {
    return this.m.mem.dv.getFloat32(this.base + i * 4, true);
  }
  str(i: number): string | null {
    const p = this.u(i);
    return p ? this.m.mem.readCString(p) : null;
  }
  wstr(i: number): string | null {
    const p = this.u(i);
    return p ? this.m.mem.readWString(p) : null;
  }
}

export interface GuestModule {
  name: string;
  path: string;
  base: number;
  size: number;
  pe: PeFile | null;
  hle: boolean;
  exports: Map<string, number>;
  ordinals: Map<number, number>;
  refs: number;
  entry: number;
  attached: boolean;
}

export interface Host {
  now(): number;
  log(msg: string): void;
}

export class MissingApi extends Error {}

export class Machine {
  readonly mem: Memory;
  readonly cpu: CPU;
  readonly as: AddressSpace;
  readonly handles = new HandleTable();
  readonly heaps = new Map<number, Heap>();
  processHeap!: Heap;
  readonly vfs: VFS;
  readonly host: Host;

  readonly fns: HleFn[] = [];
  private fnByKey = new Map<string, HleFn>();
  private defs = new Map<string, Map<string, [number, Impl]>>();
  private ordinalNames = new Map<string, Map<number, string>>();
  readonly modules: GuestModule[] = [];

  readonly threads: Thread[] = [];
  cur: Thread | null = null;
  private nextTid = 0x40;
  private rr = 0;

  exited = false;
  exitCode = 0;
  frameReady = false;
  fatal: Error | null = null;
  trace: Set<string> | "all" | null = null;
  apiCounts = false;
  /** Set by an HLE impl that has already set EIP/ESP itself (no normal return). */
  tookOver = false;

  sysPtr = SYS_BASE;
  peb = 0;
  exe: GuestModule | null = null;
  cmdLine = "";
  cmdLineA = 0;
  cmdLineW = 0;
  envA = 0;
  envW = 0;
  windowsDir = "C:\\WINDOWS";
  systemDir = "C:\\WINDOWS\\SYSTEM";
  unhandledFilter = 0;
  readonly startTime: number;
  /** Arbitrary per-subsystem state (user32 windows, gdi objects, winmm devices...). */
  readonly sub: Record<string, any> = {};
  readonly onFrame: (() => void)[] = [];

  constructor(vfs: VFS, host: Host) {
    this.mem = new Memory(GUEST_SIZE);
    this.cpu = new CPU(this.mem);
    this.cpu.hleBase = HLE_BASE;
    this.cpu.hleSize = HLE_SLOTS * 16;
    this.cpu.onHle = (i) => this.onHle(i);
    this.cpu.now = () => host.now();
    this.cpu.tscBase = host.now();
    this.as = new AddressSpace(0x00400000, HLE_MODBASE);
    this.vfs = vfs;
    this.host = host;
    this.startTime = host.now();
    this.mem.u8.fill(0xcc, HLE_BASE, HLE_BASE + HLE_SLOTS * 16);
    this.fns.push({ mod: "", name: "<return>", pop: 0, impl: null, index: 0, calls: 0 });
    this.fns.push({ mod: "", name: "<thread-exit>", pop: 0, impl: null, index: 1, calls: 0 });
    this.processHeap = this.createHeap("process");
  }

  now(): number {
    return this.host.now();
  }
  log(msg: string): void {
    this.host.log(msg);
  }

  // ---------- system memory ----------

  sysAlloc(size: number, align = 4): number {
    this.sysPtr = roundUp(this.sysPtr, align);
    const a = this.sysPtr;
    this.sysPtr += size;
    if (this.sysPtr > SYS_END) throw new Error("system area exhausted");
    this.mem.u8.fill(0, a, a + size);
    return a;
  }
  sysString(s: string): number {
    const a = this.sysAlloc(s.length + 1);
    this.mem.writeCString(a, s);
    return a;
  }
  createHeap(name: string): Heap {
    const h = new Heap(this.mem, this.as, 0, name);
    const handle = this.sysAlloc(16, 16);
    (h as { handle: number }).handle = handle;
    this.heaps.set(handle, h);
    return h;
  }
  heapOf(addr: number): Heap | null {
    for (const h of this.heaps.values()) if (h.owns(addr)) return h;
    return null;
  }
  malloc(size: number): number {
    return this.processHeap.alloc(size, true);
  }

  // ---------- HLE registry ----------

  register(mod: string, table: Record<string, [number, Impl]>, ordinals?: Record<number, string>): void {
    const key = mod.toLowerCase();
    let m = this.defs.get(key);
    if (!m) this.defs.set(key, (m = new Map()));
    for (const [name, def] of Object.entries(table)) {
      m.set(name, def);
      const existing = this.fnByKey.get(`${key}!${name}`);
      if (existing) {
        existing.impl = def[1];
        existing.pop = def[0];
      }
    }
    if (ordinals) {
      let om = this.ordinalNames.get(key);
      if (!om) this.ordinalNames.set(key, (om = new Map()));
      for (const [o, n] of Object.entries(ordinals)) om.set(Number(o), n);
    }
  }
  isHleModule(name: string): boolean {
    return this.defs.has(baseName(name));
  }
  hleOrdinalName(mod: string, ord: number): string | null {
    return this.ordinalNames.get(baseName(mod))?.get(ord) ?? null;
  }
  hasImpl(mod: string, name: string): boolean {
    return this.defs.get(baseName(mod))?.has(name) ?? false;
  }
  /** Thunk address for mod!name, creating a placeholder if not implemented. */
  thunk(mod: string, name: string): number {
    const key = `${baseName(mod)}!${name}`;
    let fn = this.fnByKey.get(key);
    if (!fn) {
      const def = this.defs.get(baseName(mod))?.get(name);
      fn = { mod: baseName(mod), name, pop: def ? def[0] : 0, impl: def ? def[1] : null, index: this.fns.length, calls: 0 };
      if (fn.index >= HLE_SLOTS) throw new Error("out of HLE slots");
      this.fns.push(fn);
      this.fnByKey.set(key, fn);
    }
    return HLE_BASE + fn.index * 16;
  }
  /** Thunk for a JS function that guest code can call (callbacks we hand out, e.g. COM vtables). */
  callback(name: string, pop: number, impl: Impl): number {
    const fn: HleFn = { mod: "<cb>", name, pop, impl, index: this.fns.length, calls: 0 };
    this.fns.push(fn);
    return HLE_BASE + fn.index * 16;
  }
  thunkName(addr: number): string | null {
    const i = (addr - HLE_BASE) >>> 4;
    if (addr < HLE_BASE || i >= this.fns.length) return null;
    return `${this.fns[i].mod}!${this.fns[i].name}`;
  }

  // ---------- dispatch ----------

  private onHle(index: number): void {
    const cpu = this.cpu;
    const t = this.cur!;
    if (index === RET_THUNK) return this.onCallbackReturn(t);
    if (index === EXIT_THUNK) return this.exitThread(t, cpu.r[EAX] >>> 0);
    const fn = this.fns[index];
    if (!fn) throw new Error(`bad HLE index ${index}`);
    const esp = cpu.r[ESP] >>> 0;
    const ret = cpu.dv.getUint32(esp, true);
    if (!fn.impl) {
      throw new MissingApi(`unimplemented ${fn.mod}!${fn.name} called from ${hex(ret)}`);
    }
    fn.calls++;
    const a = new Args(this, esp + 4);
    if (this.trace && (this.trace === "all" || this.trace.has(fn.name))) {
      this.log(`[t${t.id}] ${fn.mod}!${fn.name}(${[0, 1, 2, 3].map((i) => hex(a.u(i))).join(", ")}) <- ${hex(ret)}`);
    }
    const r = fn.impl(this, a);
    if (this.tookOver) {
      this.tookOver = false;
      return;
    }
    if (r !== undefined && typeof r === "object") {
      const frame: Frame = { gen: r, ret, esp, pop: fn.pop, cbEsp: 0, cbArgs: 0 };
      t.frames.push(frame);
      this.stepFrame(t, frame, 0);
    } else {
      this.finishCall(ret, esp, fn.pop, r);
    }
  }

  private finishCall(ret: number, esp: number, pop: number, r: number | void): void {
    const cpu = this.cpu;
    if (typeof r === "number") cpu.r[EAX] = r;
    cpu.r[ESP] = esp + 4 + pop;
    cpu.eip = ret;
  }

  stepFrame(t: Thread, frame: Frame, input: number): void {
    const cpu = this.cpu;
    const res = frame.gen.next(input);
    if (res.done) {
      const top = t.frames.pop();
      if (top !== frame) throw new Error("HLE frame stack corrupted");
      if (frame.ret === 0) {
        this.exitThread(t, (res.value as number) ?? 0);
        return;
      }
      if (frame.ret === 0xffffffff) {
        return;
      }
      this.finishCall(frame.ret, frame.esp, frame.pop, res.value);
      return;
    }
    this.handleReq(t, frame, res.value);
  }

  private handleReq(t: Thread, frame: Frame, req: Req): void {
    const cpu = this.cpu;
    switch (req.t) {
      case "call": {
        let sp = frame.esp;
        for (let i = req.args.length - 1; i >= 0; i--) {
          sp -= 4;
          cpu.dv.setUint32(sp, req.args[i], true);
        }
        sp -= 4;
        cpu.dv.setUint32(sp, HLE_BASE + RET_THUNK * 16, true);
        cpu.r[ESP] = sp;
        frame.cbEsp = sp;
        frame.cbArgs = req.args.length;
        cpu.eip = req.addr >>> 0;
        return;
      }
      case "wait":
        t.wait = { objs: req.objs, all: req.all, deadline: req.deadline, msgs: req.msgs };
        t.state = "blocked";
        t.resume = { frame, value: 0 };
        cpu.stopReq = true;
        return;
      case "yield":
        t.resume = { frame, value: 0 };
        cpu.stopReq = true;
        return;
    }
  }

  private onCallbackReturn(t: Thread): void {
    const cpu = this.cpu;
    const esp = cpu.r[ESP] >>> 0;
    while (t.frames.length) {
      const f = t.frames[t.frames.length - 1];
      if (f.cbEsp && esp >= f.cbEsp + 4 && esp <= f.cbEsp + 4 + f.cbArgs * 4) break;
      this.log(`dropping stale HLE frame (esp ${hex(esp)}, frame cbEsp ${hex(f.cbEsp)})`);
      t.frames.pop();
    }
    const f = t.frames[t.frames.length - 1];
    if (!f) throw new Error(`callback return with no HLE frame at esp ${hex(esp)}`);
    f.cbEsp = 0;
    cpu.r[ESP] = f.esp;
    this.stepFrame(t, f, cpu.r[EAX] >>> 0);
  }

  // ---------- modules ----------

  findModule(name: string): GuestModule | undefined {
    const b = baseName(name);
    return this.modules.find((m) => m.name === b);
  }
  moduleAt(addr: number): GuestModule | undefined {
    return this.modules.find((m) => addr >= m.base && addr < m.base + m.size);
  }

  private hleModule(name: string): GuestModule {
    const b = baseName(name);
    let m = this.findModule(b);
    if (m) return m;
    const idx = this.modules.filter((x) => x.hle).length;
    const base = HLE_MODBASE + idx * 0x10000;
    if (base + 0x10000 > HLE_BASE) throw new Error("too many HLE modules");
    const u8 = this.mem.u8, dv = this.mem.dv;
    u8.fill(0, base, base + 0x1000);
    dv.setUint16(base, 0x5a4d, true);
    dv.setUint32(base + 0x3c, 0x80, true);
    dv.setUint32(base + 0x80, 0x4550, true);
    dv.setUint16(base + 0x84, 0x14c, true);
    dv.setUint16(base + 0x96, 0x2102, true);
    dv.setUint16(base + 0x98, 0x10b, true);
    dv.setUint32(base + 0x98 + 28, base, true);
    dv.setUint32(base + 0x98 + 56, 0x10000, true);
    m = { name: b, path: `${this.systemDir}\\${b}`, base, size: 0x10000, pe: null, hle: true, exports: new Map(),
      ordinals: new Map(), refs: 1, entry: 0, attached: true };
    this.modules.push(m);
    return m;
  }

  /** Resolve an export of a loaded module (name or ordinal). Returns 0 if not found. */
  resolveExport(m: GuestModule, name: string | null, ordinal: number, forImport: boolean): number {
    if (m.hle) {
      let n = name ?? this.hleOrdinalName(m.name, ordinal);
      if (!n) n = `#${ordinal}`;
      if (!forImport && !this.hasImpl(m.name, n)) return 0;
      return this.thunk(m.name, n);
    }
    let rva = name !== null ? m.exports.get(name) : m.ordinals.get(ordinal);
    if (rva === undefined) return 0;
    const fwd = m.pe?.exports.find((e) => e.rva === rva && e.forward)?.forward;
    if (fwd) {
      const dot = fwd.indexOf(".");
      const target = this.loadModuleSync(fwd.slice(0, dot) + ".dll");
      const sym = fwd.slice(dot + 1);
      return target ? this.resolveExport(target, sym.startsWith("#") ? null : sym, Number(sym.slice(1)), forImport) : 0;
    }
    return m.base + rva;
  }

  readFileBytes(path: string): Uint8Array | null {
    const n = this.vfs.lookup(path);
    if (!n || n.isDir) return null;
    const buf = new Uint8Array(n.length);
    n.read(0, buf, 0, buf.length);
    return buf;
  }

  private searchDll(name: string): string | null {
    const cands: string[] = [];
    if (/[\\/:]/.test(name)) cands.push(name);
    else {
      const exeDir = this.exe ? dirName(this.exe.path) : this.vfs.cwd;
      for (const d of [exeDir, this.vfs.cwd, this.systemDir, this.windowsDir]) cands.push(`${d}\\${name}`);
    }
    for (const c of cands) {
      const full = this.vfs.full(c.includes(".") ? c : c + ".dll");
      if (full && this.vfs.lookup(full) && !this.vfs.lookup(full)!.isDir) return full;
    }
    return null;
  }

  /**
   * Maps a module and its dependencies without running DLL entry points.
   * Newly loaded modules needing DllMain are appended to `pendingInit`.
   */
  loadModuleSync(name: string, pendingInit: GuestModule[] = []): GuestModule | null {
    const existing = this.findModule(name);
    if (existing) {
      existing.refs++;
      return existing;
    }
    const path = this.searchDll(name);
    if (!path) {
      if (this.isHleModule(name)) return this.hleModule(name);
      return null;
    }
    return this.loadImage(path, pendingInit);
  }

  loadImage(path: string, pendingInit: GuestModule[]): GuestModule {
    const data = this.readFileBytes(path);
    if (!data) throw new Error(`cannot read ${path}`);
    const pe = parsePe(data);
    let base = pe.imageBase;
    if (!this.as.reserveAt(base, pe.sizeOfImage, baseName(path))) {
      if (!pe.relocRva) throw new Error(`${path}: preferred base ${hex(base)} taken and no relocations`);
      base = this.as.reserve(pe.sizeOfImage, baseName(path));
      if (!base) throw new Error(`${path}: no address space`);
    }
    mapImage(pe, this.mem.u8, base);
    this.cpu.invalidate(base, pe.sizeOfImage);
    const m: GuestModule = {
      name: baseName(path), path, base, size: pe.sizeOfImage, pe, hle: false, exports: new Map(), ordinals: new Map(),
      refs: 1, entry: pe.entry ? base + pe.entry : 0, attached: false,
    };
    for (const e of pe.exports) {
      if (e.name) m.exports.set(e.name, e.rva);
      m.ordinals.set(e.ordinal, e.rva);
    }
    this.modules.push(m);
    for (const imp of pe.imports) {
      const dep = this.loadModuleSync(imp.dll, pendingInit);
      if (!dep) throw new Error(`${m.name}: missing dependency ${imp.dll}`);
      for (const e of imp.entries) {
        let addr = this.resolveExport(dep, e.name, e.ordinal, true);
        if (!addr) {
          this.log(`${m.name}: unresolved import ${imp.dll}!${e.name ?? "#" + e.ordinal}`);
          addr = this.thunk(dep.name, e.name ?? `#${e.ordinal}`);
        }
        this.mem.dv.setUint32(base + e.iatRva, addr, true);
      }
    }
    if (pe.isDll) pendingInit.push(m);
    this.log(`loaded ${m.name} at ${hex(base)}${base !== pe.imageBase ? " (relocated)" : ""}`);
    return m;
  }

  /** Generator that loads a DLL and runs DllMain for it and any new dependencies. */
  *loadLibrary(name: string): HleGen {
    const pending: GuestModule[] = [];
    const m = this.loadModuleSync(name, pending);
    if (!m) return 0;
    for (const p of pending) {
      if (p.entry && !p.attached) {
        p.attached = true;
        const ok = yield { t: "call", addr: p.entry, args: [p.base, 1, 0] };
        if (!ok) this.log(`DllMain of ${p.name} returned FALSE`);
      }
      p.attached = true;
    }
    return m.base;
  }

  // ---------- threads ----------

  createThread(stackSize: number, start: number, param: number, rootGen?: HleGen): Thread {
    const t = new Thread(this.nextTid);
    this.nextTid += 4;
    stackSize = Math.max(roundUp(stackSize || 0x100000, 0x10000), 0x40000);
    const stack = this.as.reserve(stackSize, `stack:t${t.id}`);
    if (!stack) throw new Error("no memory for stack");
    t.stackBase = stack;
    t.stackTop = stack + stackSize;
    t.teb = this.sysAlloc(0x1000, 0x1000);
    const dv = this.mem.dv;
    dv.setUint32(t.teb + 0x00, 0xffffffff, true);
    dv.setUint32(t.teb + 0x04, t.stackTop, true);
    dv.setUint32(t.teb + 0x08, stack, true);
    dv.setUint32(t.teb + 0x18, t.teb, true);
    dv.setUint32(t.teb + 0x20, 0x10, true);
    dv.setUint32(t.teb + 0x24, t.id, true);
    dv.setUint32(t.teb + 0x2c, t.teb + 0xf00, true);
    dv.setUint32(t.teb + 0x30, this.peb, true);
    const ctx = t.ctx;
    ctx.fsBase = t.teb;
    let sp = t.stackTop - 16;
    if (rootGen) {
      const frame: Frame = { gen: rootGen, ret: 0, esp: sp, pop: 0, cbEsp: 0, cbArgs: 0 };
      t.frames.push(frame);
      t.resume = { frame, value: 0 };
      ctx.regs[ESP] = sp;
    } else {
      sp -= 4;
      dv.setUint32(sp, param, true);
      sp -= 4;
      dv.setUint32(sp, HLE_BASE + EXIT_THUNK * 16, true);
      ctx.regs[ESP] = sp;
      ctx.eip = start;
    }
    t.handle = this.handles.add(t);
    this.threads.push(t);
    return t;
  }

  exitThread(t: Thread, code: number): void {
    t.state = "done";
    t.exitCode = code;
    t.frames = [];
    t.resume = null;
    if (t === this.cur) this.cpu.stopReq = true;
    if (this.threads.every((x) => x.state === "done")) {
      this.exited = true;
      this.exitCode = code;
    }
  }

  exitProcess(code: number): void {
    this.exited = true;
    this.exitCode = code;
    this.cpu.stopReq = true;
    this.log(`process exited with code ${code}`);
  }

  private checkWait(t: Thread, now: number): boolean {
    const w = t.wait!;
    const objs = w.objs;
    let value = -1;
    if (w.msgs !== undefined && this.hasInput(t, w.msgs)) value = objs.length;
    else if (w.all && objs.length) {
      if (objs.every((o) => o.signaled(t))) {
        for (const o of objs) o.acquire(t);
        value = 0;
      }
    } else {
      for (let i = 0; i < objs.length; i++) {
        if (objs[i].signaled(t)) {
          objs[i].acquire(t);
          value = i;
          break;
        }
      }
    }
    if (value < 0 && now >= w.deadline) value = 0x102;
    if (value < 0) return false;
    t.wait = null;
    t.state = "ready";
    if (t.resume) t.resume.value = value;
    return true;
  }

  /** Overridden by user32 to report pending messages/input for a thread. */
  hasInput: (t: Thread, mask: number) => boolean = (t) => t.queue.length > 0;
  readonly pollers: ((now: number) => void)[] = [];

  /** Earliest time a blocked thread could wake on its own (timeouts), or Infinity. */
  nextWake(): number {
    let w = Infinity;
    for (const t of this.threads) if (t.state === "blocked" && t.wait) w = Math.min(w, t.wait.deadline);
    return w;
  }

  private pick(now: number): Thread | null {
    const n = this.threads.length;
    let best: Thread | null = null;
    for (let k = 0; k < n; k++) {
      const t = this.threads[(this.rr + k) % n];
      if (t.suspend > 0) continue;
      if (t.state === "blocked" && !this.checkWait(t, now)) continue;
      if (t.state !== "ready") continue;
      if (!best || t.priority > best.priority) best = t;
    }
    if (best) this.rr = (this.threads.indexOf(best) + 1) % n;
    return best;
  }

  switchTo(t: Thread): void {
    if (this.cur === t) return;
    if (this.cur && this.cur.state !== "done") this.cur.ctx.save(this.cpu);
    this.cur = t;
    t.ctx.load(this.cpu);
  }

  /** Runs guest threads for up to `ms` milliseconds. */
  run(ms: number): "frame" | "idle" | "exit" | "slice" {
    const end = this.now() + ms;
    this.frameReady = false;
    while (!this.exited) {
      const now = this.now();
      if (now >= end) return "slice";
      for (const p of this.pollers) p(now);
      const t = this.pick(now);
      if (!t) return "idle";
      this.switchTo(t);
      const cpu = this.cpu;
      cpu.stopReq = false;
      try {
        if (t.resume) {
          const r = t.resume;
          t.resume = null;
          this.stepFrame(t, r.frame, r.value);
        }
        if (t.state === "ready" && !cpu.stopReq && !this.exited) cpu.run(200000);
      } catch (e) {
        if (e instanceof GuestFault || e instanceof RangeError) {
          this.raiseFromFault(t, e);
        } else {
          this.fatal = e as Error;
          this.exited = true;
          throw e;
        }
      }
      if (this.cur && this.cur.state !== "done") this.cur.ctx.save(cpu);
      if (this.frameReady) return "frame";
    }
    return "exit";
  }

  // ---------- structured exceptions ----------

  private raiseFromFault(t: Thread, e: Error): void {
    const cpu = this.cpu;
    let code = STATUS_ACCESS_VIOLATION;
    const params: number[] = [];
    if (e instanceof GuestFault) {
      if (e.kind === "DE") code = STATUS_INT_DIVIDE;
      else if (e.kind === "BP") {
        code = STATUS_BREAKPOINT;
      } else if (e.kind === "UD") code = STATUS_ILLEGAL_INSN;
      else if (e.kind === "GP") code = STATUS_PRIV_INSN;
      else params.push(0, 0);
    } else params.push(0, 0);
    this.log(`guest exception ${hex(code)} at ${hex(cpu.eip)} (${this.symbolize(cpu.eip)}): ${e.message}`);
    this.raise(t, code, 0, cpu.eip, params);
  }

  /** Starts SEH dispatch on thread t (must be current) for an exception at `eip`. */
  raise(t: Thread, code: number, flags: number, eip: number, params: number[]): void {
    const gen = this.dispatchException(t, code, flags, eip, params);
    const frame: Frame = { gen, ret: 0xffffffff, esp: ((this.cpu.r[ESP] >>> 0) - 0x800) & ~15, pop: 0, cbEsp: 0, cbArgs: 0 };
    t.frames.push(frame);
    this.stepFrame(t, frame, 0);
  }

  /** Writes a CONTEXT record (i386, CONTEXT_FULL) for the current CPU state. */
  writeContext(addr: number, eip: number): void {
    const cpu = this.cpu, dv = this.mem.dv;
    this.mem.u8.fill(0, addr, addr + 0x2cc);
    dv.setUint32(addr, 0x1003f, true);
    const order = [7, 6, 3, 2, 1, 0];
    for (let i = 0; i < 6; i++) dv.setUint32(addr + 0x9c + i * 4, cpu.r[order[i]], true);
    dv.setUint32(addr + 0xb4, cpu.r[5], true);
    dv.setUint32(addr + 0xb8, eip, true);
    dv.setUint32(addr + 0xbc, 0x1b, true);
    dv.setUint32(addr + 0xc0, cpu.getFlags(), true);
    dv.setUint32(addr + 0xc4, cpu.r[ESP], true);
    dv.setUint32(addr + 0xc8, 0x23, true);
    dv.setUint32(addr + 0x8c, 0x0, true);
    dv.setUint32(addr + 0x90, 0x3b, true);
    dv.setUint32(addr + 0x94, 0x23, true);
    dv.setUint32(addr + 0x98, 0x23, true);
  }
  loadContext(addr: number): void {
    const cpu = this.cpu, dv = this.mem.dv;
    const order = [7, 6, 3, 2, 1, 0];
    for (let i = 0; i < 6; i++) cpu.r[order[i]] = dv.getUint32(addr + 0x9c + i * 4, true);
    cpu.r[5] = dv.getUint32(addr + 0xb4, true);
    cpu.eip = dv.getUint32(addr + 0xb8, true);
    cpu.setFlags(dv.getUint32(addr + 0xc0, true));
    cpu.r[ESP] = dv.getUint32(addr + 0xc4, true);
  }

  *dispatchException(t: Thread, code: number, flags: number, eip: number, params: number[]): HleGen {
    const cpu = this.cpu, dv = this.mem.dv;
    const base = ((cpu.r[ESP] >>> 0) - 0x400) & ~15;
    const rec = base, ctx = base + 0x60;
    this.mem.u8.fill(0, rec, rec + 0x50);
    dv.setUint32(rec, code, true);
    dv.setUint32(rec + 4, flags, true);
    dv.setUint32(rec + 12, eip, true);
    dv.setUint32(rec + 16, params.length, true);
    params.forEach((p, i) => dv.setUint32(rec + 20 + i * 4, p, true));
    this.writeContext(ctx, eip);
    const teb = t.teb;
    let reg = dv.getUint32(teb, true);
    let guard = 0;
    while (reg !== 0xffffffff && reg !== 0 && guard++ < 1000) {
      const handler = dv.getUint32(reg + 4, true);
      const r = yield { t: "call", addr: handler, args: [rec, reg, ctx, base + 0x340] };
      if (r === 0) {
        this.loadContext(ctx);
        return;
      }
      reg = dv.getUint32(reg, true);
    }
    if (this.unhandledFilter) {
      const ptrs = base + 0x348;
      dv.setUint32(ptrs, rec, true);
      dv.setUint32(ptrs + 4, ctx, true);
      const r = yield { t: "call", addr: this.unhandledFilter, args: [ptrs] };
      if (r === 0xffffffff) {
        this.loadContext(ctx);
        return;
      }
    }
    const msg = `unhandled exception ${hex(code)} at ${hex(eip)} (${this.symbolize(eip)})`;
    this.log(msg);
    this.fatal = new Error(msg);
    this.exitProcess(code);
  }

  symbolize(addr: number): string {
    const th = this.thunkName(addr);
    if (th) return th;
    const m = this.moduleAt(addr);
    if (!m || !m.pe) return "?";
    let best: string | null = null, bestRva = -1;
    const rva = addr - m.base;
    for (const e of m.pe.exports) {
      if (e.rva <= rva && e.rva > bestRva && e.name) {
        bestRva = e.rva;
        best = e.name;
      }
    }
    return best ? `${m.name}!${best}+${hex(rva - bestRva)}` : `${m.name}+${hex(rva)}`;
  }

  /** Call stack guess by scanning the guest stack for return addresses into code. */
  backtrace(max = 16, t: Thread | null = null): string[] {
    const own = !t || t === this.cur;
    const out = [this.symbolize(own ? this.cpu.eip : t.ctx.eip)];
    let sp = (own ? this.cpu.r[ESP] : t.ctx.regs[ESP]) >>> 0;
    const th = own ? this.cur : t;
    const top = th ? th.stackTop : sp + 0x1000;
    for (; sp < top && out.length < max; sp += 4) {
      const v = this.mem.dv.getUint32(sp, true);
      const m = this.moduleAt(v);
      if (m && !m.hle) {
        const sec = m.pe?.sections.find((s) => v - m.base >= s.va && v - m.base < s.va + s.vsize);
        if (sec && sec.chars & 0x20000000) out.push(`${hex(sp)}: ${this.symbolize(v)}`);
      }
    }
    return out;
  }
}

export function hex(v: number): string {
  return "0x" + (v >>> 0).toString(16);
}
export function baseName(p: string): string {
  let b = p.replace(/\//g, "\\");
  b = b.slice(b.lastIndexOf("\\") + 1).toLowerCase();
  if (!b.includes(".")) b += ".dll";
  return b;
}
export function dirName(p: string): string {
  const i = p.lastIndexOf("\\");
  return i > 2 ? p.slice(0, i) : p.slice(0, 3);
}

export function* waitFor(m: Machine, objs: KObject[], all: boolean, timeout: number, msgs?: number): Generator<Req, number, number> {
  const deadline = timeout === 0xffffffff ? Infinity : m.now() + timeout;
  return yield { t: "wait", objs, all, deadline, msgs };
}
