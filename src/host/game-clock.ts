/** Continuous guest time: changing speed never jumps existing timer deadlines. */
export class GameClock {
  private last: number;
  private elapsed = 0;
  private rate = 1;
  constructor(private realNow: () => number) { this.last = realNow(); }
  now(): number {
    const next = this.realNow();
    this.elapsed += Math.max(0, next - this.last) * this.rate;
    this.last = next;
    return this.elapsed;
  }
  setSpeed(rate: number): void { this.now(); this.rate = rate; }
  get speed(): number { return this.rate; }
}
