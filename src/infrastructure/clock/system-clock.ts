import type { IClock } from '../../business/shared/port/clock.port';

export class SystemClock implements IClock {
  now(): Date {
    return new Date();
  }
}
