import { createDevOwlet } from '../devOwlet';
import { HR_THRESHOLD } from '../constants';

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('createDevOwlet()', () => {
  it('reports heart_rate at or above HR_THRESHOLD before sleepDelaySeconds has elapsed', async () => {
    const devOwlet = createDevOwlet(10);

    const first = await devOwlet.read();
    expect(first.heart_rate).not.toBeNull();
    expect(first.heart_rate!).toBeGreaterThanOrEqual(HR_THRESHOLD);

    jest.advanceTimersByTime(5000);
    const second = await devOwlet.read();
    expect(second.heart_rate!).toBeGreaterThanOrEqual(HR_THRESHOLD);
  });

  it('reports heart_rate below HR_THRESHOLD after sleepDelaySeconds has elapsed', async () => {
    const devOwlet = createDevOwlet(10);

    await devOwlet.read();
    jest.advanceTimersByTime(10_000);
    const reading = await devOwlet.read();

    expect(reading.heart_rate!).toBeLessThan(HR_THRESHOLD);
  });

  it('measures elapsed time from the first read() call, not from module load', async () => {
    const devOwlet = createDevOwlet(10);

    // Time passes before the first read() is ever made.
    jest.advanceTimersByTime(20_000);

    const first = await devOwlet.read();
    expect(first.heart_rate!).toBeGreaterThanOrEqual(HR_THRESHOLD);

    jest.advanceTimersByTime(9000);
    const stillAwake = await devOwlet.read();
    expect(stillAwake.heart_rate!).toBeGreaterThanOrEqual(HR_THRESHOLD);

    jest.advanceTimersByTime(1000);
    const asleep = await devOwlet.read();
    expect(asleep.heart_rate!).toBeLessThan(HR_THRESHOLD);
  });

  it('always populates sock_connected, base_on, sock_off, oxygen, and battery', async () => {
    const devOwlet = createDevOwlet(10);

    const before = await devOwlet.read();
    expect(before.sock_connected).not.toBeNull();
    expect(before.base_on).not.toBeNull();
    expect(before.sock_off).not.toBeNull();
    expect(before.oxygen).not.toBeNull();
    expect(before.battery).not.toBeNull();

    jest.advanceTimersByTime(10_000);
    const after = await devOwlet.read();
    expect(after.sock_connected).not.toBeNull();
    expect(after.base_on).not.toBeNull();
    expect(after.sock_off).not.toBeNull();
    expect(after.oxygen).not.toBeNull();
    expect(after.battery).not.toBeNull();
  });
});
