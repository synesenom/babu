import { renderHook, act } from '@testing-library/react-native';
import { useRoutine } from '../useRoutine';
import * as spotifyApi from '../../lib/spotifyApi';
import * as spotifyAuth from '../../lib/spotifyAuth';
import * as foregroundService from '../../lib/foregroundService';
import { POLL_INTERVAL_MS, WHITENOISE_PLAYLIST, CHOPIN_PLAYLIST } from '../../lib/constants';
import type { OwletReading, SpotifyTokens, SpotifyPlayback } from '../../lib/types';
import type { Owlet } from '../../lib/owlet';

jest.mock('../../lib/owlet');
jest.mock('../../lib/spotifyApi');
jest.mock('../../lib/spotifyAuth');
jest.mock('../../lib/foregroundService');

const mockGetCurrentPlayback = spotifyApi.getCurrentPlayback as jest.Mock;
const mockFindDeviceByName = spotifyApi.findDeviceByName as jest.Mock;
const mockStartPlaylist = spotifyApi.startPlaylist as jest.Mock;
const mockGetValidToken = spotifyAuth.getValidToken as jest.Mock;
const mockStartService = foregroundService.startForegroundService as jest.Mock;
const mockUpdateService = foregroundService.updateForegroundService as jest.Mock;
const mockStopService = foregroundService.stopForegroundService as jest.Mock;
const mockAddTickListener = foregroundService.addTickListener as jest.Mock;

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
  // resetAllMocks, not clearAllMocks: clearing only wipes recorded calls, so any
  // mockResolvedValueOnce a test queued but did not consume (a test that ends as
  // soon as the routine switches leaves the rest of its playback script behind)
  // survives into the next test and is handed out as its first playback.
  jest.resetAllMocks();
  mockGetCurrentPlayback.mockResolvedValue(null);
  mockFindDeviceByName.mockResolvedValue('dev1');
  mockStartPlaylist.mockResolvedValue(true);
  mockGetValidToken.mockResolvedValue('refreshed-access-token');
  mockStartService.mockResolvedValue(true);
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
    .mockResolvedValueOnce({ ...MOCK_PLAYBACK, remaining_seconds: 30, remaining_ms: 30000 })
    .mockResolvedValueOnce({ ...MOCK_PLAYBACK, remaining_seconds: 18, remaining_ms: 18000 })
    .mockResolvedValueOnce(TRACK_TAIL);

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval(); // poll 1: HR 90 locks in the transition; track has 30s left → wait
  expect(result.current.state.status).toBe('transitioning');
  expect(mockStartPlaylist).not.toHaveBeenCalled();

  await advanceInterval(); // poll 2: 18s left → still outside the tail window
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
    .mockResolvedValueOnce({ ...MOCK_PLAYBACK, remaining_seconds: 25, remaining_ms: 25000 })
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
    .mockResolvedValueOnce({ ...MOCK_PLAYBACK, remaining_seconds: 45, remaining_ms: 45000 })
    .mockResolvedValueOnce({ ...MOCK_PLAYBACK, remaining_seconds: 28, remaining_ms: 28000 })
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

// ---------------------------------------------------------------------------
// 14. The switch must not depend on a poll landing inside a narrow window.
//     With a 5s poll interval and a 5s tail window there is zero margin: a tick
//     skipped by the in-flight guard (the Owlet auth chain routinely outruns the
//     poll interval) or a slow round trip means no poll ever observes the tail,
//     and the routine sits in "transitioning" through track after track without
//     ever starting white noise — the reported bug.
// ---------------------------------------------------------------------------

it('switches when a poll lands in the tail window but outside the old 5s threshold', async () => {
  const owlet = makeOwlet([{ heart_rate: 90 }]);
  mockGetCurrentPlayback
    .mockResolvedValueOnce({ ...MOCK_PLAYBACK, remaining_seconds: 30, remaining_ms: 30000 })
    .mockResolvedValue({ ...MOCK_PLAYBACK, remaining_seconds: 9, remaining_ms: 9000 });

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval(); // poll 1: transition locked; 30s left → wait
  expect(result.current.state.status).toBe('transitioning');
  expect(mockStartPlaylist).not.toHaveBeenCalled();

  // 9s left is inside the tail window: the next poll is not guaranteed to
  // arrive before the boundary, so this is the last safe chance to switch.
  await advanceInterval();

  expect(result.current.state.status).toBe('done');
  expect(mockStartPlaylist).toHaveBeenCalledWith(
    MOCK_TOKENS.access_token,
    WHITENOISE_PLAYLIST,
    'dev1',
  );
});

it('switches immediately when the playlist auto-advanced between polls, instead of waiting out another track', async () => {
  const owlet = makeOwlet([{ heart_rate: 90 }]);
  mockGetCurrentPlayback
    .mockResolvedValueOnce({ ...MOCK_PLAYBACK, remaining_seconds: 40, remaining_ms: 40000 })
    .mockResolvedValueOnce({ ...MOCK_PLAYBACK, remaining_seconds: 22, remaining_ms: 22000 })
    // No poll saw the tail — the boundary came and went between polls and a
    // fresh nocturne is already playing. Waiting for *its* tail risks missing
    // that one too, forever. Switch now.
    .mockResolvedValue({
      ...MOCK_PLAYBACK,
      track_name: 'Nocturne Op. 27 No. 2',
      remaining_seconds: 260,
      remaining_ms: 260000,
    });

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval(); // poll 1: transition locked; 40s left → wait
  expect(result.current.state.status).toBe('transitioning');

  await advanceInterval(); // poll 2: 22s left → wait
  expect(result.current.state.status).toBe('transitioning');
  expect(mockStartPlaylist).not.toHaveBeenCalled();

  await advanceInterval(); // poll 3: different track → boundary missed → switch now

  expect(result.current.state.status).toBe('done');
  expect(mockStartPlaylist).toHaveBeenCalledWith(
    MOCK_TOKENS.access_token,
    WHITENOISE_PLAYLIST,
    'dev1',
  );
});

it('switches when the same track repeats between polls (remaining_seconds jumps back up)', async () => {
  const owlet = makeOwlet([{ heart_rate: 90 }]);
  mockGetCurrentPlayback
    .mockResolvedValueOnce({ ...MOCK_PLAYBACK, remaining_seconds: 35, remaining_ms: 35000 })
    // Same track name, but the position jumped backwards: a boundary passed
    // (single-track repeat), so the tail was missed just the same.
    .mockResolvedValue({ ...MOCK_PLAYBACK, remaining_seconds: 250, remaining_ms: 250000 });

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();
  expect(result.current.state.status).toBe('transitioning');
  expect(mockStartPlaylist).not.toHaveBeenCalled();

  await advanceInterval();

  expect(result.current.state.status).toBe('done');
  expect(mockStartPlaylist).toHaveBeenCalledWith(
    MOCK_TOKENS.access_token,
    WHITENOISE_PLAYLIST,
    'dev1',
  );
});

it('switches immediately when playback is paused while transitioning', async () => {
  const owlet = makeOwlet([{ heart_rate: 90 }]);
  // Nothing is winding down — a paused player would otherwise hold
  // remaining_seconds steady forever and the switch would never fire.
  mockGetCurrentPlayback.mockResolvedValue({
    ...MOCK_PLAYBACK,
    is_playing: false,
    remaining_seconds: 120,
    remaining_ms: 120000,
  });

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
});

// ---------------------------------------------------------------------------
// 15. A switch that did not actually start white noise must not be reported as
//     done. Silently clearing the poll and navigating to the Done screen while
//     Chopin (or silence) plays on looks exactly like "it never switched".
// ---------------------------------------------------------------------------

it('does not report done when the Spotify device cannot be found, and retries on the next poll', async () => {
  const owlet = makeOwlet([{ heart_rate: 90 }]);
  mockGetCurrentPlayback.mockResolvedValue(TRACK_TAIL);
  mockFindDeviceByName.mockResolvedValueOnce(null).mockResolvedValue('dev1');

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval(); // poll 1: tail reached, but the device is gone

  expect(result.current.state.status).toBe('transitioning');
  expect(result.current.state.error).toMatch(/device/i);
  expect(mockStartPlaylist).not.toHaveBeenCalled();

  await advanceInterval(); // poll 2: device is back → the switch retries

  expect(result.current.state.status).toBe('done');
  expect(mockStartPlaylist).toHaveBeenCalledWith(
    MOCK_TOKENS.access_token,
    WHITENOISE_PLAYLIST,
    'dev1',
  );
});

it('retries a failed switch on the next poll even after the playlist has moved on', async () => {
  const owlet = makeOwlet([{ heart_rate: 90 }]);
  mockFindDeviceByName.mockResolvedValueOnce(null).mockResolvedValue('dev1');
  mockGetCurrentPlayback
    .mockResolvedValueOnce(TRACK_TAIL)
    // The retry must not go back to waiting for a tail it may never see.
    .mockResolvedValue({ ...MOCK_PLAYBACK, remaining_seconds: 260, remaining_ms: 260000 });

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();
  expect(result.current.state.status).toBe('transitioning');

  await advanceInterval();

  expect(result.current.state.status).toBe('done');
  expect(mockStartPlaylist).toHaveBeenCalledWith(
    MOCK_TOKENS.access_token,
    WHITENOISE_PLAYLIST,
    'dev1',
  );
});

it('does not report done when startPlaylist fails, and retries on the next poll', async () => {
  const owlet = makeOwlet([{ heart_rate: 90 }]);
  mockGetCurrentPlayback.mockResolvedValue(TRACK_TAIL);
  mockStartPlaylist.mockResolvedValueOnce(false).mockResolvedValue(true);

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval(); // poll 1: Spotify refuses the play call

  expect(result.current.state.status).toBe('transitioning');
  expect(result.current.state.error).toBeTruthy();

  await advanceInterval(); // poll 2: retry succeeds

  expect(result.current.state.status).toBe('done');
  expect(mockStartPlaylist).toHaveBeenCalledTimes(2);
});

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

// ---------------------------------------------------------------------------
// 16. Android foreground service. Without one the OS is free to freeze the JS
//     timers (Doze, or an OEM background killer) as soon as the app leaves the
//     foreground or the screen goes off, so the routine silently stops polling
//     and the transition never happens. The routine owns the service lifetime:
//     it starts with the polling and stops when the polling stops.
// ---------------------------------------------------------------------------

it('start() starts the foreground service so the routine survives backgrounding', async () => {
  const owlet = makeOwlet([{ heart_rate: 120 }]);
  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  expect(mockStartService).toHaveBeenCalled();
});

it('starts the foreground service in monitorOnly mode too', async () => {
  const owlet = makeOwlet([{ heart_rate: 90 }]);
  const { result } = await renderHook(() =>
    useRoutine(owlet, MOCK_TOKENS, 'iphone', POLL_INTERVAL_MS, true),
  );

  await act(async () => {
    result.current.start();
  });

  expect(mockStartService).toHaveBeenCalled();
});

it('updates the notification with the live reading on each tick', async () => {
  const owlet = makeOwlet([{ heart_rate: 118 }, { heart_rate: 116 }]);
  mockGetCurrentPlayback.mockResolvedValue(MOCK_PLAYBACK);

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();
  expect(mockUpdateService).toHaveBeenLastCalledWith(expect.stringContaining('118'));

  await advanceInterval();
  expect(mockUpdateService).toHaveBeenLastCalledWith(expect.stringContaining('116'));
});

it('says the routine is waiting out the track once a transition is locked in', async () => {
  const owlet = makeOwlet([{ heart_rate: 90 }]);
  mockGetCurrentPlayback.mockResolvedValue({
    ...MOCK_PLAYBACK,
    remaining_seconds: 200,
    remaining_ms: 200000,
  });

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();

  expect(result.current.state.status).toBe('transitioning');
  expect(mockUpdateService).toHaveBeenLastCalledWith(expect.stringMatching(/sleep/i));
});

it('stops the foreground service once white noise is playing', async () => {
  const owlet = makeOwlet([{ heart_rate: 90 }]);
  mockGetCurrentPlayback.mockResolvedValue(TRACK_TAIL);

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();

  expect(result.current.state.status).toBe('done');
  expect(mockStopService).toHaveBeenCalled();
});

it('keeps the foreground service alive while a failed switch is still retrying', async () => {
  const owlet = makeOwlet([{ heart_rate: 90 }]);
  mockGetCurrentPlayback.mockResolvedValue(TRACK_TAIL);
  mockFindDeviceByName.mockResolvedValue(null);

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();

  expect(result.current.state.status).toBe('transitioning');
  expect(mockStopService).not.toHaveBeenCalled();
});

it('stop() stops the foreground service', async () => {
  const owlet = makeOwlet([{ heart_rate: 120 }]);
  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });
  await act(async () => {
    result.current.stop();
  });

  expect(mockStopService).toHaveBeenCalled();
});

it('keeps polling when the foreground service cannot be started', async () => {
  // A device that refuses the service (permission denied, unsupported OEM) must
  // still get the in-app routine — it just will not survive backgrounding.
  mockStartService.mockResolvedValue(false);
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
// 17. Who drives the poll loop. React Native tears down its timer frame callback
//     in onHostPause, so a JS setInterval is not a loop that can be relied on
//     once the app leaves the screen. When the native service offers a tick
//     stream, the routine is driven by that instead; the interval remains the
//     fallback for everywhere the native module does not exist.
// ---------------------------------------------------------------------------

it('is driven by the native tick stream when the foreground service provides one', async () => {
  let nativeTick: (() => void) | undefined;
  const remove = jest.fn();
  mockAddTickListener.mockImplementation((cb: () => void) => {
    nativeTick = cb;
    return { remove };
  });

  const owlet = makeOwlet([{ heart_rate: 120 }]);
  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  // No JS interval may be running: advancing timers must poll nothing.
  await advanceInterval();
  expect(owlet.read).not.toHaveBeenCalled();

  await act(async () => {
    nativeTick?.();
    await new Promise<void>((r) => setImmediate(r));
  });

  expect(owlet.read).toHaveBeenCalledTimes(1);
  expect(result.current.state.lastReading?.heart_rate).toBe(120);
});

it('unsubscribes from the native tick stream on stop', async () => {
  const remove = jest.fn();
  mockAddTickListener.mockReturnValue({ remove });

  const owlet = makeOwlet([{ heart_rate: 120 }]);
  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });
  await act(async () => {
    result.current.stop();
  });

  expect(remove).toHaveBeenCalled();
});

it('falls back to the JS interval when there is no native tick stream', async () => {
  mockAddTickListener.mockReturnValue(null);

  const owlet = makeOwlet([{ heart_rate: 120 }]);
  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();

  expect(owlet.read).toHaveBeenCalledTimes(1);
});

it('passes the poll interval to the foreground service so native ticks match it', async () => {
  const owlet = makeOwlet([{ heart_rate: 120 }]);
  const { result } = await renderHook(() =>
    useRoutine(owlet, MOCK_TOKENS, 'iphone', 7000),
  );

  await act(async () => {
    result.current.start();
  });

  expect(mockStartService).toHaveBeenCalledWith(expect.any(String), expect.any(String), 7000);
});

it('falls back to the JS interval when the service fails to start after subscribing', async () => {
  // The native module exists (so a subscription is handed out), but the service
  // never starts — no native tick will ever arrive. Without a fallback the
  // routine would sit there polling nothing at all, which is worse than having
  // no service in the first place.
  const remove = jest.fn();
  mockAddTickListener.mockReturnValue({ remove });
  mockStartService.mockResolvedValue(false);

  const owlet = makeOwlet([{ heart_rate: 120 }]);
  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
    await new Promise<void>((r) => setImmediate(r));
  });

  await advanceInterval();

  expect(remove).toHaveBeenCalled();
  expect(owlet.read).toHaveBeenCalledTimes(1);
});

it('does not start a JS interval when the service fails but the routine was already stopped', async () => {
  const remove = jest.fn();
  mockAddTickListener.mockReturnValue({ remove });
  let resolveStart!: (ok: boolean) => void;
  mockStartService.mockReturnValue(new Promise<boolean>((r) => { resolveStart = r; }));

  const owlet = makeOwlet([{ heart_rate: 120 }]);
  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });
  await act(async () => {
    result.current.stop();
  });
  await act(async () => {
    resolveStart(false);
    await new Promise<void>((r) => setImmediate(r));
  });

  await advanceInterval();

  expect(owlet.read).not.toHaveBeenCalled();
});
