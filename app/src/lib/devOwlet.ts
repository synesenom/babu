import type { OwletReading } from './types';
import { HR_THRESHOLD } from './constants';

// Dev-mode mock Owlet: reports a normal heart rate until sleepDelaySeconds
// have elapsed since the *first* read() call, then reports one below
// HR_THRESHOLD so the transition logic can be exercised offline.
export function createDevOwlet(sleepDelaySeconds: number): { read: () => Promise<OwletReading> } {
  let firstReadAt: number | null = null;

  return {
    async read(): Promise<OwletReading> {
      const now = Date.now();
      if (firstReadAt === null) {
        firstReadAt = now;
      }
      const elapsedSeconds = (now - firstReadAt) / 1000;
      const asleep = elapsedSeconds >= sleepDelaySeconds;

      return {
        heart_rate: asleep ? HR_THRESHOLD - 30 : HR_THRESHOLD,
        oxygen: 98,
        battery: 80,
        movement: 'still',
        sock_off: false,
        sock_connected: true,
        base_on: true,
        charging: false,
        dsn: 'dev-mock-dsn',
        timestamp: new Date().toISOString(),
        raw: {},
      };
    },
  };
}
