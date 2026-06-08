import { renderHook, act } from '@testing-library/react-native';
import { useRoutine } from '../useRoutine';
import * as spotifyApi from '../../lib/spotifyApi';
import { POLL_INTERVAL_MS, WHITENOISE_PLAYLIST } from '../../lib/constants';
import type { OwletReading, SpotifyTokens, SpotifyPlayback } from '../../lib/types';
import type { Owlet } from '../../lib/owlet';

jest.mock('../../lib/owlet');
jest.mock('../../lib/spotifyApi');

const mockGetCurrentPlayback = spotifyApi.getCurrentPlayback as jest.Mock;
const mockFindDeviceByName = spotifyApi.findDeviceByName as jest.Mock;
const mockStartPlaylist = spotifyApi.startPlaylist as jest.Mock;

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
