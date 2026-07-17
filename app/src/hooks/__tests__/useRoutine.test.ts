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

// A Chopin track in its final seconds — a live poll seeing this is the routine's
// cue to switch to white noise before the repeating playlist auto-advances.
const TRACK_TAIL = { ...MOCK_PLAYBACK, remaining_seconds: 3, remaining_ms: 3000 };

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
// 4. Sleep detection (HR below threshold) — switch happens on the live track
//    tail, not after a blind wait-out-the-track timer.
// ---------------------------------------------------------------------------

it('after HR drops below threshold, stays transitioning until a live poll shows the track tail, then switches to white noise', async () => {
  const owlet = makeOwlet([{ heart_rate: 90 }]);
  mockGetCurrentPlayback
    .mockResolvedValueOnce({ ...MOCK_PLAYBACK, remaining_seconds: 12, remaining_ms: 12000 })
    .mockResolvedValueOnce({ ...MOCK_PLAYBACK, remaining_seconds: 7, remaining_ms: 7000 })
    .mockResolvedValueOnce(TRACK_TAIL);

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval(); // poll 1: HR 90 locks in the transition; track has 12s left → wait
  expect(result.current.state.status).toBe('transitioning');
  expect(mockStartPlaylist).not.toHaveBeenCalled();

  await advanceInterval(); // poll 2: 7s left → still wait
  expect(result.current.state.status).toBe('transitioning');
  expect(mockStartPlaylist).not.toHaveBeenCalled();

  await advanceInterval(); // poll 3: 3s left (track tail) → switch before it auto-advances
  expect(result.current.state.status).toBe('done');
  expect(mockStartPlaylist).toHaveBeenCalledWith(
    MOCK_TOKENS.access_token,
    WHITENOISE_PLAYLIST,
    'dev1',
  );
});

// ---------------------------------------------------------------------------
// 4b. Switch immediately when nothing is playing at sleep detection — there is
//     no track to wind down.
// ---------------------------------------------------------------------------

it('switches to white noise immediately when nothing is playing at sleep detection', async () => {
  const owlet = makeOwlet([{ heart_rate: 90 }]);
  mockGetCurrentPlayback.mockResolvedValue(null);

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();

  expect(result.current.state.status).toBe('done');
  expect(mockStartPlaylist).toHaveBeenCalledWith(
    MOCK_TOKENS.access_token,
    WHITENOISE_PLAYLIST,
    'dev1',
  );
  expect(mockStartPlaylist).not.toHaveBeenCalledWith(
    expect.anything(),
    CHOPIN_PLAYLIST,
    expect.anything(),
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
  // Track already at its tail, so the switch fires on the first poll.
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

it('does not restart Chopin once a transition is in progress, but keeps polling until the track tail', async () => {
  // tick 1's read resolves low (transition); tick 2 would read high (keep-alive)
  // but must never run because tick 1 holds the re-entrancy guard while it's
  // in flight. Once tick 1 locks in the transition, later ticks must only wait
  // for the current track's tail and switch to white noise — never restart
  // Chopin, even though HR has climbed back above the threshold.
  let resolveRead!: (r: OwletReading) => void;
  const read = jest
    .fn()
    .mockImplementationOnce(
      () => new Promise<OwletReading>((res) => { resolveRead = res; }),
    )
    .mockResolvedValue({ ...DEFAULT_READING, heart_rate: 130 });
  const owlet = { read } as unknown as Owlet;
  mockGetCurrentPlayback
    .mockResolvedValueOnce({ ...MOCK_PLAYBACK, remaining_seconds: 7, remaining_ms: 7000 })
    .mockResolvedValue(TRACK_TAIL);

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval(); // tick 1 fires, blocks on pending low read
  await advanceInterval(); // tick 2 fires while tick 1 in flight — must be skipped

  // Release tick 1's low reading → it locks in the transition; the track still
  // has 7s left so no switch yet, and polling continues.
  await act(async () => {
    resolveRead({ ...DEFAULT_READING, heart_rate: 90 });
    await new Promise<void>((r) => setImmediate(r));
  });
  expect(result.current.state.status).toBe('transitioning');

  await advanceInterval(); // a live tick runs: HR 130 (ignored), track tail → switch

  expect(read).toHaveBeenCalledTimes(2);
  expect(result.current.state.lastReading?.heart_rate).toBe(130);
  expect(result.current.state.status).toBe('done');
  expect(mockStartPlaylist).toHaveBeenCalledWith(MOCK_TOKENS.access_token, WHITENOISE_PLAYLIST, 'dev1');
  expect(mockStartPlaylist).not.toHaveBeenCalledWith(
    expect.anything(),
    CHOPIN_PLAYLIST,
    expect.anything(),
  );
});

// ---------------------------------------------------------------------------
// 13. Vitals keep updating live while a transition waits out the remaining
//     track — the routine must not freeze the displayed HR/O2/battery at
//     whatever reading triggered the transition.
// ---------------------------------------------------------------------------

it('keeps polling live owlet vitals while a transition waits for the current track to end', async () => {
  const owlet = makeOwlet([{ heart_rate: 90 }, { heart_rate: 85 }, { heart_rate: 80 }]);
  mockGetCurrentPlayback
    .mockResolvedValueOnce({ ...MOCK_PLAYBACK, remaining_seconds: 20, remaining_ms: 20000 })
    .mockResolvedValueOnce({ ...MOCK_PLAYBACK, remaining_seconds: 12, remaining_ms: 12000 })
    .mockResolvedValueOnce(TRACK_TAIL);

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval(); // poll 1: HR 90 triggers the transition; 20s left → wait
  expect(result.current.state.status).toBe('transitioning');
  expect(result.current.state.lastReading?.heart_rate).toBe(90);
  expect(mockStartPlaylist).not.toHaveBeenCalled();

  await advanceInterval(); // poll 2: still waiting — vitals must keep updating
  expect(result.current.state.status).toBe('transitioning');
  expect(result.current.state.lastReading?.heart_rate).toBe(85);
  expect((owlet.read as jest.Mock)).toHaveBeenCalledTimes(2);
  expect(mockStartPlaylist).not.toHaveBeenCalled();

  await advanceInterval(); // poll 3: track tail → switch, with the latest vitals shown
  expect(result.current.state.status).toBe('done');
  expect(result.current.state.lastReading?.heart_rate).toBe(80);
  expect((owlet.read as jest.Mock)).toHaveBeenCalledTimes(3);
  expect(mockStartPlaylist).toHaveBeenCalledWith(MOCK_TOKENS.access_token, WHITENOISE_PLAYLIST, 'dev1');
  expect(mockStartPlaylist).not.toHaveBeenCalledWith(
    expect.anything(),
    CHOPIN_PLAYLIST,
    expect.anything(),
  );
});

// ---------------------------------------------------------------------------
// 12. The switch decision is made from a *live* poll of the current track, not
//     a one-shot snapshot taken at sleep-detection time. A blind wait based on
//     the first snapshot fires seconds into the next repeated Chopin track,
//     because the playlist auto-advances at the boundary — the reported bug.
// ---------------------------------------------------------------------------

it('switches on the live track tail, never bleeding into an auto-advanced next Chopin track', async () => {
  const owlet = makeOwlet([{ heart_rate: 90 }]);
  // First poll sees a fresh 200s track. A blind wait-out-the-track timer would
  // fire ~200s later — landing seconds into the *next* repeated Chopin track.
  // The routine must keep polling and switch only when a live poll shows the
  // current track in its final seconds.
  mockGetCurrentPlayback
    .mockResolvedValueOnce({ ...MOCK_PLAYBACK, remaining_seconds: 200, remaining_ms: 200000 })
    .mockResolvedValue(TRACK_TAIL);

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval(); // poll 1: transition locked; 200s left → must NOT switch yet
  expect(result.current.state.status).toBe('transitioning');
  expect(mockStartPlaylist).not.toHaveBeenCalled();

  await advanceInterval(); // poll 2: track tail → switch to white noise
  expect(result.current.state.status).toBe('done');
  expect(mockStartPlaylist).toHaveBeenCalledWith(
    MOCK_TOKENS.access_token,
    WHITENOISE_PLAYLIST,
    'dev1',
  );
  expect(mockStartPlaylist).not.toHaveBeenCalledWith(
    expect.anything(),
    CHOPIN_PLAYLIST,
    expect.anything(),
  );
});
