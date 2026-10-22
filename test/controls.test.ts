import { describe, expect, it } from "vitest";
import { buttonChanges, Controls, DEFAULT_CONTROLS } from "../src/host/controls";

function input() {
  const events: [string, boolean][] = [];
  const controls = new Controls((code, down) => events.push([code, down]));
  return { controls, events };
}

describe("browser control presets", () => {
  it("maps movement, jump, action and the inaccessible numpad look key", () => {
    const { controls, events } = input();
    for (const code of ["KeyW", "Space", "KeyE", "KeyC", "KeyM"]) {
      controls.key(code, true); controls.key(code, false);
      if (code === "Space") { controls.keyboardRead(); controls.tick(140); }
    }
    expect(events).toEqual([...["ArrowUp", "ControlLeft", "Space", "Numpad0", "End"].flatMap((code) => [[code, true], [code, false]])]);
  });
  it("preserves original keys and supports typing names without aliases", () => {
    const { controls, events } = input();
    controls.configure({ ...DEFAULT_CONTROLS, typing: true });
    controls.key("KeyW", true); controls.key("KeyW", false);
    controls.configure({ ...DEFAULT_CONTROLS, preset: "original" });
    controls.key("Space", true); controls.button(0, true);
    expect(events).toEqual([["KeyW", true], ["KeyW", false], ["Space", true]]);
  });
  it("does not release a shared action until both keyboard and mouse release it", () => {
    const { controls, events } = input();
    controls.key("KeyE", true); controls.button(0, true); controls.button(0, false);
    expect(events).toEqual([["Space", true]]);
    controls.key("KeyE", false);
    expect(events.at(-1)).toEqual(["Space", false]);
  });
  it("aims only with the right button held, releases motion, and supports inverted Y", () => {
    const { controls, events } = input();
    controls.move(40, -40); controls.tick(100);
    expect(events).toEqual([]);
    controls.button(2, true); controls.move(40, -40); controls.tick(116);
    expect(events).toEqual([["Numpad0", true], ["ArrowRight", true], ["ArrowUp", true]]);
    controls.tick(166); controls.tick(216); controls.tick(266);
    expect(events).toContainEqual(["ArrowRight", false]);
    controls.configure({ ...DEFAULT_CONTROLS, invertY: true });
    controls.button(2, true); controls.move(0, -40); controls.tick(300);
    expect(events.at(-1)).toEqual(["ArrowDown", true]);
    controls.button(2, false);
    expect(events.slice(-2)).toEqual([["ArrowDown", false], ["Numpad0", false]]);
  });
  it("resets held inputs on focus loss or preset changes, without mouse releases dropping keyboard keys", () => {
    const { controls, events } = input();
    controls.key("KeyW", true); controls.button(2, true); controls.move(30, 0); controls.tick(100);
    controls.resetMouse();
    expect(events).not.toContainEqual(["ArrowUp", false]);
    controls.configure({ ...DEFAULT_CONTROLS, preset: "original" });
    expect(events.at(-1)).toEqual(["ArrowUp", false]);
    controls.key("KeyW", false);
    expect(events.at(-1)).toEqual(["ArrowUp", false]);
  });
  it("pulses the magic-selection key and clears it after the wheel stops", () => {
    const { controls, events } = input();
    controls.wheel(100); controls.tick(200); controls.tick(300);
    expect(events).toEqual([["Delete", true], ["Delete", false]]);
  });
  it("holds a firmware Space tap until the game samples it and the minimum press expires", () => {
    const { controls, events } = input();
    controls.key("Space", true, 100); controls.key("Space", false, 101);
    controls.tick(300);
    expect(events).toEqual([["ControlLeft", true]]);
    controls.keyboardRead(); controls.tick(301);
    expect(events).toEqual([["ControlLeft", true], ["ControlLeft", false]]);
    controls.key("Space", true, 400); controls.key("Space", false, 401); controls.keyboardRead();
    controls.tick(500);
    expect(events.at(-1)).toEqual(["ControlLeft", true]);
    controls.tick(540);
    expect(events.at(-1)).toEqual(["ControlLeft", false]);
  });
  it("treats a tap-hold keyboard's Left Alt hold as the space bar, but not with assistance off or while typing", () => {
    const { controls, events } = input();
    controls.key("AltLeft", true, 100); controls.key("AltLeft", false, 500);
    expect(events).toEqual([["ControlLeft", true], ["ControlLeft", false]]);
    controls.configure({ ...DEFAULT_CONTROLS, preset: "original" });
    controls.key("AltLeft", true, 600); controls.key("AltLeft", false, 900);
    expect(events.slice(-2)).toEqual([["Space", true], ["Space", false]]);
    for (const options of [{ ...DEFAULT_CONTROLS, tapAssist: false }, { ...DEFAULT_CONTROLS, typing: true }]) {
      controls.configure(options);
      controls.key("AltLeft", true, 1000); controls.key("AltLeft", false, 1300);
      expect(events.slice(-2)).toEqual([["AltLeft", true], ["AltLeft", false]]);
    }
  });
  it("preserves typing, original Space, and immediate releases when tap assistance is disabled", () => {
    const { controls, events } = input();
    controls.configure({ ...DEFAULT_CONTROLS, preset: "original" });
    controls.key("Space", true, 600); controls.key("Space", false, 601);
    controls.keyboardRead(); controls.tick(740);
    expect(events.slice(-2)).toEqual([["Space", true], ["Space", false]]);
    controls.configure({ ...DEFAULT_CONTROLS, tapAssist: false });
    controls.key("Space", true, 800); controls.key("Space", false, 801);
    expect(events.slice(-2)).toEqual([["ControlLeft", true], ["ControlLeft", false]]);
    controls.configure({ ...DEFAULT_CONTROLS, typing: true });
    controls.key("Space", true, 900); controls.key("Space", false, 901);
    expect(events.slice(-2)).toEqual([["Space", true], ["Space", false]]);
  });
  it("cancels pending taps on focus loss and bounds presses if the game never polls", () => {
    const { controls, events } = input();
    controls.key("Space", true, 100); controls.key("Space", false, 101); controls.reset(); controls.tick(2000);
    expect(events).toEqual([["ControlLeft", true], ["ControlLeft", false]]);
    controls.key("Space", true, 2000); controls.key("Space", false, 2001); controls.tick(3140);
    expect(events.slice(-2)).toEqual([["ControlLeft", true], ["ControlLeft", false]]);
  });
  it("turns PointerEvent button masks into presses and releases, including a left click while aiming", () => {
    expect(buttonChanges(0, 2)).toEqual([[2, true]]);
    expect(buttonChanges(2, 3)).toEqual([[0, true]]);
    expect(buttonChanges(3, 2)).toEqual([[0, false]]);
    expect(buttonChanges(2, 0)).toEqual([[2, false]]);
    expect(buttonChanges(0, 7)).toEqual([[0, true], [1, true], [2, true]]);
    expect(buttonChanges(5, 5)).toEqual([]);
  });
});
