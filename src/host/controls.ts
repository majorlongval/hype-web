/** Host-side aliases. The guest still sees its original keyboard controls. */
export type Preset = "original" | "modern";
export interface ControlOptions { preset: Preset; mouse: boolean; sensitivity: number; invertY: boolean; typing: boolean; tapAssist: boolean }
export const DEFAULT_CONTROLS: ControlOptions = { preset: "modern", mouse: true, sensitivity: 2, invertY: false, typing: false, tapAssist: true };
export const MODERN_KEYS: Record<string, string> = {
  KeyW: "ArrowUp", KeyS: "ArrowDown", KeyA: "ArrowLeft", KeyD: "ArrowRight",
  Space: "ControlLeft", KeyE: "Space", KeyQ: "KeyX", KeyR: "KeyZ",
  KeyF: "Delete", KeyG: "Enter", KeyC: "Numpad0", KeyM: "End",
  KeyZ: "KeyA", KeyX: "KeyS",
};

const MOUSE_BITS: [number, number][] = [[1, 0], [4, 1], [2, 2]];

/** Presses and releases between two PointerEvent.buttons masks; a second button pressed mid-drag only shows up here. */
export function buttonChanges(before: number, after: number): [number, boolean][] {
  return MOUSE_BITS.filter(([bit]) => (before & bit) !== (after & bit)).map(([bit, button]) => [button, (after & bit) !== 0]);
}

/** Tracks separate input sources so releasing a mouse button cannot release a held keyboard action. */
export class Controls {
  options = { ...DEFAULT_CONTROLS };
  private sources = new Map<string, Set<string>>();
  private held = new Set<string>();
  private x = 0;
  private y = 0;
  private last = 0;
  private wheelUntil = 0;
  private right = false;
  private space: { until: number; read: boolean; released: boolean } | null = null;
  constructor(private emit: (code: string, down: boolean) => void) {}

  configure(options: ControlOptions): void {
    this.reset();
    this.options = { ...options, sensitivity: Math.max(0.25, Math.min(6, Number(options.sensitivity) || 2)) };
  }
  private set(source: string, codes: string[]): void {
    if (codes.length) this.sources.set(source, new Set(codes));
    else this.sources.delete(source);
    const next = new Set([...this.sources.values()].flatMap((s) => [...s]));
    for (const code of this.held) if (!next.has(code)) this.emit(code, false);
    for (const code of next) if (!this.held.has(code)) this.emit(code, true);
    this.held = next;
  }
  key(code: string, down: boolean, now = 0): void {
    const assist = this.options.tapAssist && !this.options.typing;
    const key = assist && code === "AltLeft" ? "Space" : code;
    const target = this.options.preset === "modern" && !this.options.typing ? MODERN_KEYS[key] ?? key : key;
    if (code === "Space" && assist) {
      if (down) this.space = { until: now + 140, read: false, released: false };
      else if (this.space) { this.space.released = true; return; }
    }
    this.set(`key:${code}`, down ? [target] : []);
  }
  /** A near-instant firmware tap must survive until the game has sampled its keyboard. */
  keyboardRead(): void { if (this.space) this.space.read = true; }
  get mouseEnabled(): boolean { return this.options.preset === "modern" && this.options.mouse && !this.options.typing; }
  button(button: number, down: boolean): void {
    if (!this.mouseEnabled) return;
    const code = ["Space", "Enter", "Numpad0"][button];
    if (!code) return;
    if (button === 2) {
      this.right = down;
      if (!down) { this.x = this.y = 0; this.set("mouse:aim", []); }
    }
    this.set(`mouse:${button}`, down ? [code] : []);
  }
  move(dx: number, dy: number): void {
    if (!this.mouseEnabled || !this.right) return;
    this.x = Math.max(-180, Math.min(180, this.x + dx * this.options.sensitivity));
    this.y = Math.max(-180, Math.min(180, this.y + dy * this.options.sensitivity * (this.options.invertY ? -1 : 1)));
  }
  wheel(now: number): void {
    if (!this.mouseEnabled) return;
    this.wheelUntil = now + 160;
    this.set("mouse:wheel", ["Delete"]);
  }
  tick(now: number): void {
    if (this.space?.released && now >= this.space.until && (this.space.read || now >= this.space.until + 1000)) {
      this.space = null; this.set("key:Space", []);
    }
    const dt = this.last ? Math.max(0, Math.min(50, now - this.last)) : 0;
    this.last = now;
    const codes: string[] = [];
    if (this.right) {
      if (this.x) codes.push(this.x > 0 ? "ArrowRight" : "ArrowLeft");
      if (this.y) codes.push(this.y > 0 ? "ArrowDown" : "ArrowUp");
    }
    this.set("mouse:aim", codes);
    const decay = (v: number) => Math.sign(v) * Math.max(0, Math.abs(v) - dt);
    this.x = decay(this.x); this.y = decay(this.y);
    if (this.wheelUntil && now >= this.wheelUntil) { this.wheelUntil = 0; this.set("mouse:wheel", []); }
  }
  resetMouse(): void {
    this.right = false; this.x = this.y = this.wheelUntil = 0;
    for (const source of [...this.sources.keys()]) if (source.startsWith("mouse:")) this.set(source, []);
  }
  reset(): void {
    for (const code of this.held) this.emit(code, false);
    this.held.clear(); this.sources.clear();
    this.space = null;
    this.right = false; this.x = this.y = this.wheelUntil = this.last = 0;
  }
}
