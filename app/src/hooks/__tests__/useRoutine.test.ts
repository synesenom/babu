import { renderHook, act } from '@testing-library/react-native';
import { useRoutine } from '../useRoutine';
import * as spotifyApi from '../../lib/spotifyApi';
import * as spotifyAuth from '../../lib/spotifyAuth';
import { POLL_INTERVAL_MS, WHITENOISE_PLAYLIST, CHOPIN_PLAYLIST } from '../../lib/constants';
import type { OwletReading, SpotifyTokens, SpotifyPlayback } from '../../lib/types';
import type { Owlet } from '../../lib/owlet';

jest.mock('../../lib/owlet');
jest.mock('../../lib/spotifyApi');
jest.mock('../../lib/spotifyAuth');

const mockGetCurrentPlayback = spotifyApi.getCurrentPlayback as jest.Mock;
const mockFindDeviceByName = spotifyApi.findDeviceByName as jest.Mock;
const mockStartPlaylist = spotifyApi.startPlaylist as jest.Mock;
const mockGetValidToken = spotifyAuth.getValidToken as jest.Mock;

const DEFAULT_READING: OwletReading = {
  heart_rate: 120,
  oxygen: 98,
  battery: 80,
  movement: 'still',
  sock_off: false,
  sock_connected: true,
  base_on: true,
  charging: false,
  dsn: 'AC000W123456789',
  timestamp: '2024-01-01 00:00:00',
  raw: {},
};

const MOCK_PLAYBACK: SpotifyPlayback = {
  is_playing: true,
  track_name: 'Nocturne Op. 9 No. 2',
  artist_name: 'Chopin',
  album_name: 'Nocturnes',
  progress_ms: 60000,
  duration_ms: 270000,
  remaining_ms: 210000,
  remaining_seconds: 210,
  device_name: 'iPhone',
  device_id: 'dev1',
};

const MOCK_TOKENS: SpotifyTokens = {
  access_token: 'test-access-token',
  refresh_token: 'test-refresh-token',
  expires_at: Date.now() + 3600000,
};

function makeOwlet(readings: Partial<OwletReading>[]): Owlet {
  let callCount = 0;
  return {
    read: jest.fn().mockImplementation(() => {
      const overrides = readings[Math.min(callCount, readings.length - 1)];
      callCount++;
      return Promise.resolve({ ...DEFAULT_READING, ...overrides });
    }),
  } as unknown as Owlet;
}

// Advance fake timers by ms and flush resulting async operations.
// setImmediate is kept real (via doNotFake) so React / RNTL flush mechanisms work.
async function advanceInterval(ms: number = POLL_INTERVAL_MS): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await new Promise<void>(resolve => setImmediate(resolve));
  });
}

beforeEach(() => {
  // Keep setImmediate and nextTick real so React / RNTL act() flush mechanisms work.
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  jest.clearAllMocks();
  mockGetCurrentPlayback.mockResolvedValue(null);
  mockFindDeviceByName.mockResolvedValue('dev1');
  mockStartPlaylist.mockResolvedValue(true);
  mockGetValidToken.mockResolvedValue('refreshed-access-token');
});

afterEach(() => {
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. Initial state
// ---------------------------------------------------------------------------

it('initial state is { status: idle, lastReading: null, nowPlaying: null, error: null }', async () => {
  const owlet = makeOwlet([]);
  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  expect(result.current.state).toEqual({
    status: 'idle',
    lastReading: null,
    nowPlaying: null,
    error: null,
  });
});

// ---------------------------------------------------------------------------
// 2. start() → running
// ---------------------------------------------------------------------------

it('start() transitions status to running', async () => {
  const owlet = makeOwlet([]);
  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  expect(result.current.state.status).toBe('running');
});

// ---------------------------------------------------------------------------
// 3. Normal tick (HR above threshold)
// ---------------------------------------------------------------------------

it('after one tick with HR 120, status stays running and lastReading.heart_rate is 120', async () => {
  const owlet = makeOwlet([{ heart_rate: 120 }]);
  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();

  expect(result.current.state.status).toBe('running');
  expect(result.current.state.lastReading?.heart_rate).toBe(120);
});

// ---------------------------------------------------------------------------
// 4. Sleep detection (HR below threshold)
// ---------------------------------------------------------------------------

it('after tick with HR 90, transitions to transitioning then done after remaining track time', async () => {
  const REMAINING_SECONDS = 15;
  const owlet = makeOwlet([{ heart_rate: 90 }]);
  mockGetCurrentPlayback.mockResolvedValue({
    ...MOCK_PLAYBACK,
    remaining_seconds: REMAINING_SECONDS,
    remaining_ms: REMAINING_SECONDS * 1000,
  });

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();

  expect(result.current.state.status).toBe('transitioning');

  await advanceInterval(REMAINING_SECONDS * 1000);

  expect(result.current.state.status).toBe('done');
  expect(mockStartPlaylist).toHaveBeenCalledWith(
    MOCK_TOKENS.access_token,
    WHITENOISE_PLAYLIST,
    'dev1',
  );
});

// ---------------------------------------------------------------------------
// 5. stop() while running
// ---------------------------------------------------------------------------

it('stop() while running returns status to idle and clears the interval', async () => {
  const owlet = makeOwlet([{ heart_rate: 120 }]);
  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await act(async () => {
    result.current.stop();
  });

  expect(result.current.state.status).toBe('idle');

  const readCallsBefore = (owlet.read as jest.Mock).mock.calls.length;

  await advanceInterval();

  expect((owlet.read as jest.Mock).mock.calls.length).toBe(readCallsBefore);
});

// ---------------------------------------------------------------------------
// 6. Owlet read() throws
// ---------------------------------------------------------------------------

it('when owlet.read() throws, status stays running and state.error is set', async () => {
  const owlet = makeOwlet([]);
  (owlet.read as jest.Mock).mockRejectedValue(new Error('Sock disconnected'));

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();

  expect(result.current.state.status).toBe('running');
  expect(result.current.state.error).toBe('Sock disconnected');
});

// ---------------------------------------------------------------------------
// 7. null heart_rate (sock disconnected)
// ---------------------------------------------------------------------------

it('null heart_rate (sock off) does not trigger sleep transition, status stays running', async () => {
  const owlet = makeOwlet([{ heart_rate: null, sock_off: true }]);
  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();

  expect(result.current.state.status).toBe('running');
  expect(result.current.state.lastReading?.heart_rate).toBeNull();
  expect(result.current.state.lastReading?.sock_off).toBe(true);
});

// ---------------------------------------------------------------------------
// 8. nowPlaying updated each tick
// ---------------------------------------------------------------------------

it('nowPlaying is updated from getCurrentPlayback() on each tick', async () => {
  const owlet = makeOwlet([{ heart_rate: 120 }, { heart_rate: 120 }]);
  mockGetCurrentPlayback
    .mockResolvedValueOnce(MOCK_PLAYBACK)
    .mockResolvedValueOnce({ ...MOCK_PLAYBACK, track_name: 'Nocturne Op. 15 No. 2' });

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();

  expect(result.current.state.nowPlaying?.track_name).toBe('Nocturne Op. 9 No. 2');

  await advanceInterval();

  expect(result.current.state.nowPlaying?.track_name).toBe('Nocturne Op. 15 No. 2');
});

// ---------------------------------------------------------------------------
// 9. monitorOnly mode — no transition triggered
// ---------------------------------------------------------------------------

it('monitorOnly: HR below threshold keeps status running and never calls startPlaylist', async () => {
  const owlet = makeOwlet([{ heart_rate: 90 }]);
  mockGetCurrentPlayback.mockResolvedValue({ ...MOCK_PLAYBACK, remaining_seconds: 10, remaining_ms: 10000 });

  const { result } = await renderHook(() =>
    useRoutine(owlet, MOCK_TOKENS, 'iphone', POLL_INTERVAL_MS, true),
  );

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();

  expect(result.current.state.status).toBe('running');
  expect(mockStartPlaylist).not.toHaveBeenCalled();
});

it('monitorOnly: vitals and nowPlaying are still updated each tick', async () => {
  const owlet = makeOwlet([{ heart_rate: 90 }, { heart_rate: 85 }]);
  mockGetCurrentPlayback
    .mockResolvedValueOnce(MOCK_PLAYBACK)
    .mockResolvedValueOnce({ ...MOCK_PLAYBACK, track_name: 'Nocturne Op. 15 No. 2' });

  const { result } = await renderHook(() =>
    useRoutine(owlet, MOCK_TOKENS, 'iphone', POLL_INTERVAL_MS, true),
  );

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();
  expect(result.current.state.lastReading?.heart_rate).toBe(90);
  expect(result.current.state.nowPlaying?.track_name).toBe('Nocturne Op. 9 No. 2');

  await advanceInterval();
  expect(result.current.state.lastReading?.heart_rate).toBe(85);
  expect(result.current.state.nowPlaying?.track_name).toBe('Nocturne Op. 15 No. 2');
});

// ---------------------------------------------------------------------------
// 10. Token refresh — the access token is refreshed each tick so an expired
//     token never reaches the Spotify API (the daily 403 bug).
// ---------------------------------------------------------------------------

it('refreshes the access token via getValidToken each tick and uses it for Spotify calls', async () => {
  mockGetValidToken.mockResolvedValue('fresh-token');
  const owlet = makeOwlet([{ heart_rate: 120 }]);
  mockGetCurrentPlayback.mockResolvedValue(MOCK_PLAYBACK);

  const { result } = await renderHook(() =>
    useRoutine(owlet, MOCK_TOKENS, 'iphone', POLL_INTERVAL_MS, false, 'client-id'),
  );

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();

  expect(mockGetValidToken).toHaveBeenCalledWith('client-id');
  expect(mockGetCurrentPlayback).toHaveBeenCalledWith('fresh-token');
});

it('uses the refreshed token when starting the white-noise playlist after sleep detection', async () => {
  mockGetValidToken.mockResolvedValue('fresh-token');
  const owlet = makeOwlet([{ heart_rate: 90 }]);
  mockGetCurrentPlayback.mockResolvedValue({ ...MOCK_PLAYBACK, remaining_seconds: 0, remaining_ms: 0 });

  const { result } = await renderHook(() =>
    useRoutine(owlet, MOCK_TOKENS, 'iphone', POLL_INTERVAL_MS, false, 'client-id'),
  );

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();

  expect(result.current.state.status).toBe('done');
  expect(mockFindDeviceByName).toHaveBeenCalledWith('fresh-token', 'iphone');
  expect(mockStartPlaylist).toHaveBeenCalledWith('fresh-token', WHITENOISE_PLAYLIST, 'dev1');
});

it('falls back to the passed token when no client credentials are provided', async () => {
  const owlet = makeOwlet([{ heart_rate: 120 }]);
  mockGetCurrentPlayback.mockResolvedValue(MOCK_PLAYBACK);

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();

  expect(mockGetValidToken).not.toHaveBeenCalled();
  expect(mockGetCurrentPlayback).toHaveBeenCalledWith(MOCK_TOKENS.access_token);
});

it('falls back to the passed token when the refresh fails (getValidToken returns null)', async () => {
  mockGetValidToken.mockResolvedValue(null);
  const owlet = makeOwlet([{ heart_rate: 120 }]);
  mockGetCurrentPlayback.mockResolvedValue(MOCK_PLAYBACK);

  const { result } = await renderHook(() =>
    useRoutine(owlet, MOCK_TOKENS, 'iphone', POLL_INTERVAL_MS, false, 'client-id'),
  );

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();

  expect(mockGetCurrentPlayback).toHaveBeenCalledWith(MOCK_TOKENS.access_token);
});

// ---------------------------------------------------------------------------
// 11. Re-entrancy — ticks must not overlap. The Owlet auth chain + Spotify
//     calls can take longer than the poll interval; without a guard, a second
//     tick fires while the first is still in flight, racing the transition
//     against the Chopin keep-alive branch (transition shown, Chopin restarted,
//     never switches to white noise).
// ---------------------------------------------------------------------------

it('skips a tick while the previous tick is still in flight (no overlapping reads)', async () => {
  let resolveRead!: (r: OwletReading) => void;
  const read = jest
    .fn()
    .mockImplementationOnce(
      () => new Promise<OwletReading>((res) => { resolveRead = res; }),
    )
    .mockResolvedValue({ ...DEFAULT_READING, heart_rate: 120 });
  const owlet = { read } as unknown as Owlet;

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  // First interval: tick 1 fires and blocks on the pending read.
  await advanceInterval();
  // Second interval: tick 2 fires while tick 1 is still awaiting — must be skipped.
  await advanceInterval();

  expect(read).toHaveBeenCalledTimes(1);

  // Let tick 1 complete so the guard is released and no promises dangle.
  await act(async () => {
    resolveRead({ ...DEFAULT_READING, heart_rate: 120 });
    await new Promise<void>((r) => setImmediate(r));
  });
});

it('does not restart Chopin once a transition is in progress', async () => {
  // tick 1's read resolves low (transition); tick 2 would read high (keep-alive)
  // but must never run because tick 1 holds the re-entrancy guard through the
  // remaining-track wait.
  let resolveRead!: (r: OwletReading) => void;
  const read = jest
    .fn()
    .mockImplementationOnce(
      () => new Promise<OwletReading>((res) => { resolveRead = res; }),
    )
    .mockResolvedValue({ ...DEFAULT_READING, heart_rate: 130 });
  const owlet = { read } as unknown as Owlet;
  mockGetCurrentPlayback.mockResolvedValue({
    ...MOCK_PLAYBACK,
    remaining_seconds: 5,
    remaining_ms: 5000,
  });

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval(); // tick 1 fires, blocks on pending low read
  await advanceInterval(); // tick 2 fires while tick 1 in flight — must be skipped

  // Release tick 1's low reading → it should transition and start white noise.
  await act(async () => {
    resolveRead({ ...DEFAULT_READING, heart_rate: 90 });
    await new Promise<void>((r) => setImmediate(r));
  });
  await advanceInterval(5000); // wait out the remaining track

  expect(read).toHaveBeenCalledTimes(1);
  expect(mockStartPlaylist).toHaveBeenCalledWith(MOCK_TOKENS.access_token, WHITENOISE_PLAYLIST, 'dev1');
  expect(mockStartPlaylist).not.toHaveBeenCalledWith(
    expect.anything(),
    CHOPIN_PLAYLIST,
    expect.anything(),
  );
});
