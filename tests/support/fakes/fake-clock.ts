import type { IClock } from '../../../src/business/shared/port/clock.port';

export class FakeClock implements IClock {
  private current: Date;

  constructor(start: Date = new Date('2026-07-29T15:00:00.000Z')) {
    this.current = new Date(start.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(at: Date): void {
    this.current = new Date(at.getTime());
  }

  advance(ms: number): Date {
    this.current = new Date(this.current.getTime() + ms);
    return this.now();
  }
}
