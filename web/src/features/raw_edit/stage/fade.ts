/** A value moving in a straight line to the last one it was sent towards, over `ms`. */
export class Fade {
  private from = 0;
  private to = 0;
  private since = Number.NEGATIVE_INFINITY;

  constructor(private readonly ms: number) {}

  get target(): number {
    return this.to;
  }

  toward(target: number, now: number): void {
    this.from = this.at(now);
    this.to = target;
    this.since = now;
  }

  at(now: number): number {
    const share = Math.min(Math.max((now - this.since) / this.ms, 0), 1);
    return share === 1 ? this.to : this.from + (this.to - this.from) * share;
  }
}
