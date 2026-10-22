import { describe, expect, it } from "vitest";
import { Controls, DEFAULT_CONTROLS } from "../src/host/controls";

function input() {
  const events: [string, boolean][] = [];
  const controls = new Controls((code, down) => events.push([code, down]));
  return { controls, events };
}

describe("browser control presets", () => {
  it("maps movement, jump, action and the inaccessible numpad look key", () => {
    const { controls, events } = input();
    for (const code of ["KeyW", "Space", "KeyE", "KeyC", "KeyM"]) { controls.key(code, true); controls.key(code, false); }
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
});
