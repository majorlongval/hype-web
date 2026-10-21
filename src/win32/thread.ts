import { KObject } from "./objects";
import type { CPU } from "../cpu/cpu";

/** What an HLE generator can ask the machine to do. */
export type Req =
  | { t: "call"; addr: number; args: number[] }
  | { t: "wait"; objs: KObject[]; all: boolean; deadline: number; msgs?: number }
  | { t: "yield" };

export type HleGen = Generator<Req, number | void, number>;

export interface Frame {
  gen: HleGen;
  /** Guest return address of the original HLE call; 0 for a thread-root generator. */
  ret: number;
  /** ESP at the HLE call (pointing at the return address). */
  esp: number;
  pop: number;
  /** ESP just after pushing the callback return thunk, while a callback is running. */
  cbEsp: number;
  cbArgs: number;
  pendingResult?: number;
}

export interface WaitState {
  objs: KObject[];
  all: boolean;
  deadline: number;
  msgs?: number;
}

export class CpuContext {
  regs = new Int32Array(8);
  eip = 0;
  flags = 0x202;
  lfOp = 0;
  lfA = 0;
  lfB = 0;
  lfRes = 0;
  lfSz = 4;
  lfCin = 0;
  lfOf = 0;
  fsBase = 0;
  fpuSt = new Float64Array(8);
  fpuEmpty = new Uint8Array(8).fill(1);
  fpuTop = 0;
  fpuCw = 0x037f;
  fpuSw = 0;
  mmx = new Uint8Array(72);

  save(c: CPU): void {
    this.regs.set(c.r);
    this.eip = c.eip;
    this.flags = c.flags;
    this.lfOp = c.lfOp;
    this.lfA = c.lfA;
    this.lfB = c.lfB;
    this.lfRes = c.lfRes;
    this.lfSz = c.lfSz;
    this.lfCin = c.lfCin;
    this.lfOf = c.lfOf;
    this.fsBase = c.segBase[4];
    this.fpuSt.set(c.fpu.st);
    this.fpuEmpty.set(c.fpu.empty);
    this.fpuTop = c.fpu.top;
    this.fpuCw = c.fpu.cw;
    this.fpuSw = c.fpu.sw;
    this.mmx.set(c.mmx.b);
  }
  load(c: CPU): void {
    c.r.set(this.regs);
    c.eip = this.eip;
    c.flags = this.flags;
    c.lfOp = this.lfOp;
    c.lfA = this.lfA;
    c.lfB = this.lfB;
    c.lfRes = this.lfRes;
    c.lfSz = this.lfSz;
    c.lfCin = this.lfCin;
    c.lfOf = this.lfOf;
    c.segBase[4] = this.fsBase;
    c.fpu.st.set(this.fpuSt);
    c.fpu.empty.set(this.fpuEmpty);
    c.fpu.top = this.fpuTop;
    c.fpu.cw = this.fpuCw;
    c.fpu.sw = this.fpuSw;
    c.mmx.b.set(this.mmx);
  }
}

export class Thread extends KObject {
  readonly kind = "thread";
  ctx = new CpuContext();
  frames: Frame[] = [];
  state: "ready" | "blocked" | "done" = "ready";
  wait: WaitState | null = null;
  /** Generator frame to resume with a value when the thread next runs. */
  resume: { frame: Frame; value: number } | null = null;
  suspend = 0;
  exitCode = 0x103;
  priority = 0;
  lastError = 0;
  tls: number[] = [];
  stackBase = 0;
  stackTop = 0;
  teb = 0;
  queue: number[][] = [];
  quitPosted = false;
  label = "";
  handle = 0;

  constructor(public id: number) {
    super();
  }

  override signaled(): boolean {
    return this.state === "done";
  }
}
