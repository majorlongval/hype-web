import { KObject } from "./objects";
import type { CPU } from "../cpu/cpu";
import { STATE_BYTES, ST_REGS, ST_SEGBASE, initState } from "../cpu/state";

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
  readonly state = new Uint8Array(STATE_BYTES);
  readonly regs = new Int32Array(this.state.buffer, ST_REGS, 8);
  eip = 0;

  constructor() {
    initState(this.state, 0);
  }

  set fsBase(v: number) {
    new DataView(this.state.buffer).setUint32(ST_SEGBASE + 16, v, true);
  }

  save(c: CPU): void {
    const b = c.mem.stateBase;
    this.state.set(c.mem.u8.subarray(b, b + STATE_BYTES));
    this.eip = c.eip;
  }
  load(c: CPU): void {
    c.mem.u8.set(this.state, c.mem.stateBase);
    c.eip = this.eip;
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
