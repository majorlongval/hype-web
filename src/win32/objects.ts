import type { Thread } from "./thread";

export abstract class KObject {
  refs = 1;
  name: string | null = null;
  abstract readonly kind: string;
  /** True if a wait on this object would be satisfied for thread t right now. */
  signaled(_t: Thread): boolean {
    return false;
  }
  /** Called when a wait is satisfied, to consume the signal (auto-reset events, mutexes, semaphores). */
  acquire(_t: Thread): void {}
  close(): void {}
}

export class KEvent extends KObject {
  readonly kind = "event";
  constructor(
    public manual: boolean,
    public state: boolean,
  ) {
    super();
  }
  override signaled(): boolean {
    return this.state;
  }
  override acquire(): void {
    if (!this.manual) this.state = false;
  }
}

export class KMutex extends KObject {
  readonly kind = "mutex";
  owner: Thread | null = null;
  count = 0;
  abandoned = false;
  override signaled(t: Thread): boolean {
    return this.owner === null || this.owner === t;
  }
  override acquire(t: Thread): void {
    this.owner = t;
    this.count++;
  }
  release(t: Thread): boolean {
    if (this.owner !== t) return false;
    if (--this.count === 0) this.owner = null;
    return true;
  }
}

export class KSemaphore extends KObject {
  readonly kind = "semaphore";
  constructor(
    public count: number,
    public max: number,
  ) {
    super();
  }
  override signaled(): boolean {
    return this.count > 0;
  }
  override acquire(): void {
    this.count--;
  }
}

export class KTimer extends KObject {
  readonly kind = "timer";
  due = Infinity;
  period = 0;
  state = false;
  constructor(public manual: boolean) {
    super();
  }
  poll(now: number): void {
    if (now >= this.due) {
      this.state = true;
      this.due = this.period ? this.due + this.period : Infinity;
    }
  }
  override signaled(): boolean {
    return this.state;
  }
  override acquire(): void {
    if (!this.manual) this.state = false;
  }
}

export class KProcess extends KObject {
  readonly kind = "process";
  exited = false;
  override signaled(): boolean {
    return this.exited;
  }
}

/** Opaque objects that only need a handle (GDI objects get their own table). */
export class KGeneric<T> extends KObject {
  constructor(
    readonly kind: string,
    public data: T,
  ) {
    super();
  }
}

export class HandleTable {
  private map = new Map<number, KObject>();
  private next = 0x100;

  add(o: KObject): number {
    const h = this.next;
    this.next += 4;
    this.map.set(h, o);
    return h;
  }
  get<T extends KObject>(h: number): T | undefined {
    return this.map.get(h >>> 0) as T | undefined;
  }
  close(h: number): boolean {
    const o = this.map.get(h >>> 0);
    if (!o) return false;
    this.map.delete(h >>> 0);
    if (--o.refs <= 0) o.close();
    return true;
  }
  dup(h: number): number {
    const o = this.map.get(h >>> 0);
    if (!o) return 0;
    o.refs++;
    return this.add(o);
  }
  findNamed(name: string): KObject | undefined {
    for (const o of this.map.values()) if (o.name === name) return o;
    return undefined;
  }
}
