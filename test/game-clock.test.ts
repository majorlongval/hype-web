import { expect, it } from "vitest";
import { GameClock } from "../src/host/game-clock";

it("speeds up and resumes without jumping timers, and freezes while paused", () => {
  let real = 100;
  const clock = new GameClock(() => real);
  real = 200; expect(clock.now()).toBe(100);
  clock.setSpeed(4); expect(clock.now()).toBe(100);
  real = 300; expect(clock.now()).toBe(500);
  clock.setSpeed(1); expect(clock.now()).toBe(500);
  real = 400; expect(clock.now()).toBe(600);
  clock.setSpeed(0); real = 1000; expect(clock.now()).toBe(600);
  clock.setSpeed(4); real = 1100; expect(clock.now()).toBe(1000);
});
