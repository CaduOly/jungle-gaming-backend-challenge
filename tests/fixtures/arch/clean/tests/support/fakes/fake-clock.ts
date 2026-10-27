export class FakeClock {
  now(): Date {
    return new Date(0);
  }
}
