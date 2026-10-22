import type { Machine, Impl } from "./machine";
import { comObject, readGuid, writeGuid, E_NOINTERFACE } from "./com";
import { KEvent } from "./objects";
import { obj } from "./kernel32";
import type { HleGen } from "./thread";

const GUID_SysKeyboard = "6F1D2B61-D5A0-11CF-BFC7-444553540000";
const GUID_SysMouse = "6F1D2B60-D5A0-11CF-BFC7-444553540000";
const GUID_Joystick = "6F1D2B70-D5A0-11CF-BFC7-444553540000";
const GUID_Pad = "A0C7E2F0-1C2A-11D2-B3E8-444553540000";
const DI_OK = 0, DIERR_NOTACQUIRED = 0x8007000c, DIERR_INPUTLOST = 0x8007001e, DI_BUFFEROVERFLOW = 1;

type Kind = "keyboard" | "mouse" | "joystick";

interface Device {
  kind: Kind;
  acquired: boolean;
  dataSize: number;
  bufferSize: number;
  buffer: [number, number, number][];
  event: number;
  ranges: Map<number, [number, number]>;
  formatOffsets: Map<number, number>;
}

export class DinputState {
  onKeyboardRead?: () => void;
  keys = new Uint8Array(256);
  seq = 0;
  devices = new Map<number, Device>();
  mouse = { dx: 0, dy: 0, buttons: [0, 0, 0, 0] };
  pad = { connected: false, axes: [0, 0, 0, 0], buttons: new Array(16).fill(0) as number[], pov: 0xffffffff };
}

export function di(m: Machine): DinputState {
  return (m.sub.dinput ??= new DinputState());
}

/** Host keyboard input in DirectInput scan codes. */
export function diKey(m: Machine, dik: number, down: boolean): void {
  const s = di(m);
  if (((s.keys[dik] & 0x80) !== 0) === down) return;
  s.keys[dik] = down ? 0x80 : 0;
  for (const d of s.devices.values()) {
    if (d.kind !== "keyboard" || !d.bufferSize) continue;
    d.buffer.push([dik, down ? 0x80 : 0, s.seq++]);
    if (d.buffer.length > d.bufferSize) d.buffer.shift();
    if (d.event) {
      const e = obj<KEvent>(m, d.event);
      if (e) e.state = true;
    }
  }
}

function deviceInstance(m: Machine, p: number, kind: Kind): void {
  const dv = m.mem.dv;
  const size = dv.getUint32(p, true) || 580;
  m.mem.fill(p + 4, size - 4, 0);
  const g = kind === "keyboard" ? GUID_SysKeyboard : kind === "mouse" ? GUID_SysMouse : GUID_Joystick;
  writeGuid(m, p + 4, g);
  writeGuid(m, p + 20, kind === "joystick" ? GUID_Pad : g);
  dv.setUint32(p + 36, kind === "keyboard" ? 0x0403 : kind === "mouse" ? 0x0102 : 0x10404, true);
  const name = kind === "keyboard" ? "Keyboard" : kind === "mouse" ? "Mouse" : "Gamepad";
  m.mem.writeCString(p + 40, name);
  m.mem.writeCString(p + 300, name);
}

function joyValue(d: Device, ofs: number, raw: number): number {
  const [lo, hi] = d.ranges.get(ofs) ?? d.ranges.get(-1) ?? [0, 65535];
  return Math.round(lo + ((raw + 1) / 2) * (hi - lo));
}

function makeDevice(m: Machine, kind: Kind, v2: boolean): number {
  const s = di(m);
  const dev: Device = { kind, acquired: false, dataSize: 0, bufferSize: 0, buffer: [], event: 0, ranges: new Map(), formatOffsets: new Map() };
  const methods: [string, number, Impl][] = [
    ["QueryInterface", 12, (mm, a) => { mm.mem.dv.setUint32(a.u(2), a.u(0), true); return 0; }],
    ["AddRef", 4, () => 2],
    ["Release", 4, () => 1],
    ["GetCapabilities", 8, (mm, a) => {
      const p = a.u(1), dv = mm.mem.dv;
      const size = dv.getUint32(p, true) || 24;
      mm.mem.fill(p + 4, size - 4, 0);
      dv.setUint32(p + 4, 1, true);
      dv.setUint32(p + 8, kind === "keyboard" ? 0x0403 : kind === "mouse" ? 0x0102 : 0x10404, true);
      dv.setUint32(p + 12, kind === "keyboard" ? 0 : kind === "mouse" ? 2 : 4, true);
      dv.setUint32(p + 16, kind === "keyboard" ? 128 : kind === "mouse" ? 3 : 12, true);
      dv.setUint32(p + 20, kind === "joystick" ? 1 : 0, true);
      return 0;
    }],
    ["EnumObjects", 16, function* (mm, a): HleGen {
      if (kind !== "joystick") return 0;
      const p = mm.processHeap.alloc(316, true), dv = mm.mem.dv;
      const axes = [[0, "X"], [4, "Y"], [12, "Rx"], [16, "Ry"]] as const;
      for (const [ofs, name] of axes) {
        mm.mem.fill(p, 316, 0);
        dv.setUint32(p, 316, true);
        writeGuid(mm, p + 4, ["A36D02E0-C9F3-11CF-BFC7-444553540000", "A36D02E1-C9F3-11CF-BFC7-444553540000", "A36D02F4-C9F3-11CF-BFC7-444553540000", "A36D02F5-C9F3-11CF-BFC7-444553540000"][axes.findIndex((x) => x[0] === ofs)]);
        dv.setUint32(p + 20, ofs, true);
        dv.setUint32(p + 24, 0x3 | ((ofs / 4) << 8), true);
        mm.mem.writeCString(p + 32, name);
        const r = yield { t: "call", addr: a.u(1), args: [p, a.u(2)] };
        if (!r) break;
      }
      for (let b = 0; b < 12; b++) {
        mm.mem.fill(p, 316, 0);
        dv.setUint32(p, 316, true);
        writeGuid(mm, p + 4, "A36D02F0-C9F3-11CF-BFC7-444553540000");
        dv.setUint32(p + 20, 48 + b, true);
        dv.setUint32(p + 24, 0xc | (b << 8), true);
        mm.mem.writeCString(p + 32, `Button ${b}`);
        const r = yield { t: "call", addr: a.u(1), args: [p, a.u(2)] };
        if (!r) break;
      }
      mm.processHeap.free(p);
      return 0;
    }],
    ["GetProperty", 12, (mm, a) => {
      const prop = a.u(1);
      if (prop === 1) { mm.mem.dv.setUint32(a.u(2) + 16, dev.bufferSize, true); return 0; }
      if (prop === 4) { const r = dev.ranges.get(-1) ?? [0, 65535]; mm.mem.dv.setInt32(a.u(2) + 16, r[0], true); mm.mem.dv.setInt32(a.u(2) + 20, r[1], true); return 0; }
      return 0x80004001;
    }],
    ["SetProperty", 12, (mm, a) => {
      const prop = a.u(1), p = a.u(2), dv = mm.mem.dv;
      if (prop === 1) dev.bufferSize = dv.getUint32(p + 16, true);
      else if (prop === 4) {
        const how = dv.getUint32(p + 12, true), o = dv.getUint32(p + 8, true);
        dev.ranges.set(how === 0 ? -1 : o, [dv.getInt32(p + 16, true), dv.getInt32(p + 20, true)]);
      }
      return 0;
    }],
    ["Acquire", 4, () => { dev.acquired = true; return 0; }],
    ["Unacquire", 4, () => { dev.acquired = false; return 0; }],
    ["GetDeviceState", 12, (mm, a) => {
      if (!dev.acquired) return DIERR_NOTACQUIRED;
      const n = a.u(1), p = a.u(2), dv = mm.mem.dv;
      mm.mem.fill(p, n, 0);
      if (kind === "keyboard") {
        mm.mem.u8.set(s.keys.subarray(0, Math.min(256, n)), p);
        s.onKeyboardRead?.();
      }
      else if (kind === "mouse") {
        dv.setInt32(p, s.mouse.dx, true);
        dv.setInt32(p + 4, s.mouse.dy, true);
        s.mouse.dx = s.mouse.dy = 0;
        for (let i = 0; i < 4 && 12 + i < n; i++) mm.mem.u8[p + 12 + i] = s.mouse.buttons[i] ? 0x80 : 0;
      } else {
        const pad = s.pad;
        dv.setInt32(p, joyValue(dev, 0, pad.axes[0]), true);
        dv.setInt32(p + 4, joyValue(dev, 4, pad.axes[1]), true);
        dv.setInt32(p + 8, joyValue(dev, 8, 0), true);
        dv.setInt32(p + 12, joyValue(dev, 12, pad.axes[2]), true);
        dv.setInt32(p + 16, joyValue(dev, 16, pad.axes[3]), true);
        dv.setInt32(p + 20, joyValue(dev, 20, 0), true);
        dv.setUint32(p + 32, pad.pov, true);
        dv.setUint32(p + 36, 0xffffffff, true);
        dv.setUint32(p + 40, 0xffffffff, true);
        dv.setUint32(p + 44, 0xffffffff, true);
        for (let i = 0; i < 16 && 48 + i < n; i++) mm.mem.u8[p + 48 + i] = pad.buttons[i] ? 0x80 : 0;
      }
      return 0;
    }],
    ["GetDeviceData", 20, (mm, a) => {
      if (!dev.acquired) return DIERR_NOTACQUIRED;
      const size = a.u(1), out = a.u(2), inout = a.u(3), flags = a.u(4), dv = mm.mem.dv;
      const max = dv.getUint32(inout, true);
      let n = 0;
      if (out === 0 && max === 0xffffffff && !(flags & 1)) {
        dev.buffer = [];
        dv.setUint32(inout, 0, true);
        return 0;
      }
      const peek = (flags & 1) !== 0;
      while (n < max && n < dev.buffer.length) {
        const [ofs, data, seq] = dev.buffer[n];
        if (out) {
          const p = out + n * size;
          dv.setUint32(p, ofs, true);
          dv.setUint32(p + 4, data, true);
          dv.setUint32(p + 8, Math.floor(mm.now()) >>> 0, true);
          dv.setUint32(p + 12, seq, true);
        }
        n++;
      }
      if (!peek) dev.buffer.splice(0, n);
      if (kind === "keyboard" && n > 0) s.onKeyboardRead?.();
      dv.setUint32(inout, n, true);
      return 0;
    }],
    ["SetDataFormat", 8, (mm, a) => {
      dev.dataSize = mm.mem.dv.getUint32(a.u(1) + 12, true);
      return 0;
    }],
    ["SetEventNotification", 8, (mm, a) => { dev.event = a.u(1); return 0; }],
    ["SetCooperativeLevel", 12, () => 0],
    ["GetObjectInfo", 16, () => 0x80004001],
    ["GetDeviceInfo", 8, (mm, a) => { deviceInstance(mm, a.u(1), kind); return 0; }],
    ["RunControlPanel", 12, () => 0],
    ["Initialize", 16, () => 0],
  ];
  if (v2) {
    methods.push(
      ["CreateEffect", 20, () => 0x80004001],
      ["EnumEffects", 16, () => 0],
      ["GetEffectInfo", 12, () => 0x80004001],
      ["GetForceFeedbackState", 8, () => 0x80004001],
      ["SendForceFeedbackCommand", 8, () => 0x80004001],
      ["EnumCreatedEffectObjects", 16, () => 0],
      ["Escape", 8, () => 0x80004001],
      ["Poll", 4, () => 0],
      ["SendDeviceData", 20, () => 0],
    );
  }
  const p = comObject(m, `IDirectInputDevice${v2 ? "2" : ""}A:${kind}:${s.devices.size}`, methods);
  s.devices.set(p, dev);
  return p;
}

export function registerDinput(m0: Machine): void {
  const create = (m: Machine, out: number) => {
    const s = di(m);
    const methods: [string, number, Impl][] = [
      ["QueryInterface", 12, (mm, a) => { mm.mem.dv.setUint32(a.u(2), a.u(0), true); return 0; }],
      ["AddRef", 4, () => 2],
      ["Release", 4, () => 1],
      ["CreateDevice", 16, (mm, a) => {
        const g = readGuid(mm, a.u(1));
        const kind: Kind | null = g === GUID_SysKeyboard ? "keyboard" : g === GUID_SysMouse ? "mouse" : g === GUID_Joystick || g === GUID_Pad ? "joystick" : null;
        if (!kind) { mm.log(`DirectInput CreateDevice unknown guid ${g}`); return 0x80040154; }
        mm.mem.dv.setUint32(a.u(2), makeDevice(mm, kind, true), true);
        return 0;
      }],
      ["EnumDevices", 20, function* (mm, a): HleGen {
        const type = a.u(1);
        const list: Kind[] = [];
        if (type === 0 || type === 3) list.push("keyboard");
        if (type === 0 || type === 2) list.push("mouse");
        if ((type === 0 || type === 4) && s.pad.connected) list.push("joystick");
        const p = mm.processHeap.alloc(580, true);
        for (const k of list) {
          mm.mem.dv.setUint32(p, 580, true);
          deviceInstance(mm, p, k);
          const r = yield { t: "call", addr: a.u(2), args: [p, a.u(3)] };
          if (!r) break;
        }
        mm.processHeap.free(p);
        return 0;
      }],
      ["GetDeviceStatus", 8, () => 0],
      ["RunControlPanel", 12, () => 0],
      ["Initialize", 12, () => 0],
    ];
    const p = comObject(m, "IDirectInputA", methods);
    m.mem.dv.setUint32(out, p, true);
    return 0;
  };
  m0.register("dinput.dll", {
    DirectInputCreateA: [16, (m, a) => create(m, a.u(2))],
    DirectInputCreateEx: [20, (m, a) => create(m, a.u(3))],
  });
}

void E_NOINTERFACE;
void DIERR_INPUTLOST;
void DI_BUFFEROVERFLOW;
void DI_OK;
