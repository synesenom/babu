import fetchMock from 'jest-fetch-mock';
import { Owlet, OwletError } from '../owlet';
import type { OwletRegion } from '../types';
import { OWLET_REGIONS } from '../constants';
import {
  FIREBASE_OK,
  MINI_TOKEN_OK,
  AYLA_SIGNIN_OK,
  DEVICES_OK,
  ACTIVATE_OK,
  PROPS_RTV_OK,
  PROPS_LEGACY_OK,
} from '../__mocks__/fixtures';

const WORLD = OWLET_REGIONS.world;

// Auth + device-list sequence needed by Owlet.create()
async function makeOwlet(): Promise<Owlet> {
  fetchMock.mockResponses(
    [JSON.stringify(FIREBASE_OK), { status: 200 }],
    [JSON.stringify(MINI_TOKEN_OK), { status: 200 }],
    [JSON.stringify(AYLA_SIGNIN_OK), { status: 200 }],
    [JSON.stringify(DEVICES_OK), { status: 200 }],
  );
  return Owlet.create('test@example.com', 'password');
}

// Kick off read() and let all timers + microtasks drain (handles the 2s pause inside read())
async function doRead(owlet: Owlet) {
  const promise = owlet.read();
  await jest.runAllTimersAsync();
  return promise;
}

beforeEach(() => {
  jest.useFakeTimers();
  fetchMock.resetMocks();
});

afterEach(() => {
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// Owlet.create()
// ---------------------------------------------------------------------------

describe('Owlet.create()', () => {
  it('makes auth fetch calls to Firebase, SSO, and Ayla with correct URLs', async () => {
    await makeOwlet();

    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls[0]).toContain(`key=${WORLD.firebase_api_key}`);
    expect(urls[1]).toBe(WORLD.url_mini);
    expect(urls[2]).toBe(WORLD.url_signin);
    expect(urls[3]).toContain('devices.json');
  });

  it('throws OwletError when Firebase returns 400', async () => {
    fetchMock.mockResponseOnce('INVALID_PASSWORD', { status: 400 });
    await expect(Owlet.create('test@example.com', 'wrongpass')).rejects.toThrow(OwletError);
  });

  it('throws OwletError when SSO returns missing mini_token', async () => {
    fetchMock.mockResponses(
      [JSON.stringify(FIREBASE_OK), { status: 200 }],
      [JSON.stringify({ not_a_mini_token: true }), { status: 200 }],
    );
    await expect(Owlet.create('test@example.com', 'password')).rejects.toThrow(OwletError);
  });

  it('throws OwletError when no devices found', async () => {
    fetchMock.mockResponses(
      [JSON.stringify(FIREBASE_OK), { status: 200 }],
      [JSON.stringify(MINI_TOKEN_OK), { status: 200 }],
      [JSON.stringify(AYLA_SIGNIN_OK), { status: 200 }],
      [JSON.stringify([]), { status: 200 }],
    );
    await expect(Owlet.create('test@example.com', 'password')).rejects.toThrow(OwletError);
  });

  it('throws when region is unknown', async () => {
    await expect(
      Owlet.create('test@example.com', 'password', 'invalid' as OwletRegion),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// read()
// ---------------------------------------------------------------------------

describe('read()', () => {
  it('calls activate then getProps and returns a parsed OwletReading', async () => {
    const owlet = await makeOwlet();
    fetchMock.resetMocks();
    fetchMock.mockResponses(
      [JSON.stringify(ACTIVATE_OK), { status: 201 }],
      [JSON.stringify(PROPS_RTV_OK), { status: 200 }],
    );

    const result = await doRead(owlet);

    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls[0]).toContain('APP_ACTIVE/datapoints.json');
    expect(urls[1]).toContain('properties.json');
    expect(result.dsn).toBe('AC000W123456789');
  });

  it('parses REAL_TIME_VITALS: correct HR, O2, movement=still, and sock flags', async () => {
    const owlet = await makeOwlet();
    fetchMock.resetMocks();
    fetchMock.mockResponses(
      [JSON.stringify(ACTIVATE_OK), { status: 201 }],
      [JSON.stringify(PROPS_RTV_OK), { status: 200 }],
    );

    const result = await doRead(owlet);

    expect(result.heart_rate).toBe(125);
    expect(result.oxygen).toBe(98);
    expect(result.battery).toBe(82);
    expect(result.movement).toBe('still');   // mv === 0
    expect(result.sock_connected).toBe(true); // sc === 1
    expect(result.sock_off).toBe(false);
    expect(result.base_on).toBe(true);        // bso === 1
    expect(result.charging).toBe(false);      // chg === 0
  });

  it('falls back to legacy individual properties when no REAL_TIME_VITALS', async () => {
    const owlet = await makeOwlet();
    fetchMock.resetMocks();
    fetchMock.mockResponses(
      [JSON.stringify(ACTIVATE_OK), { status: 201 }],
      [JSON.stringify(PROPS_LEGACY_OK), { status: 200 }],
    );

    const result = await doRead(owlet);

    expect(result.heart_rate).toBe(118);
    expect(result.oxygen).toBe(97);
    expect(result.battery).toBe(75);
    expect(result.movement).toBe('moving');   // MOVEMENT === 1
    expect(result.sock_off).toBe(false);       // SOCK_OFF === 0
    expect(result.sock_connected).toBe(true);  // SOCK_CONNECTION === 1
  });

  it('re-authenticates when token is expired', async () => {
    jest.setSystemTime(0);
    const owlet = await makeOwlet();
    // expiry set to 0 + 86400000 - 60000 = 86340000 ms

    jest.setSystemTime(86340001); // just past expiry
    fetchMock.resetMocks();
    fetchMock.mockResponses(
      // re-auth: 3 calls
      [JSON.stringify(FIREBASE_OK), { status: 200 }],
      [JSON.stringify(MINI_TOKEN_OK), { status: 200 }],
      [JSON.stringify(AYLA_SIGNIN_OK), { status: 200 }],
      // then the normal read: 2 calls
      [JSON.stringify(ACTIVATE_OK), { status: 201 }],
      [JSON.stringify(PROPS_RTV_OK), { status: 200 }],
    );

    await doRead(owlet);

    expect(fetchMock.mock.calls).toHaveLength(5);
  });
});
