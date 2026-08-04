import { renderHook, act } from '@testing-library/react-native';
import { useRoutine } from '../useRoutine';
import * as spotifyApi from '../../lib/spotifyApi';
import * as spotifyAuth from '../../lib/spotifyAuth';
import * as foregroundService from '../../lib/foregroundService';
import { POLL_INTERVAL_MS, WHITENOISE_PLAYLIST, CHOPIN_PLAYLIST } from '../../lib/constants';
import { BLIND_POLLS_BEFORE_IDLE } from '../../lib/transition';
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

/** Chopin, mid-nocturne, three and a half minutes still to play. */
const MOCK_PLAYBACK: SpotifyPlayback = {
  is_playing: true,
  track_id: 'chopin-a',
  context_uri: CHOPIN_PLAYLIST,
  track_name: 'Nocturne Op. 9 No. 2',
  artist_name: 'Chopin',
  album_name: 'Nocturnes',
  progress_ms: 60000,
  duration_ms: 270000,
  remaining_ms: 210000,
  remaining_seconds: 210,
  device_name: 'Bedroom speaker',
  device_id: 'speaker-1',
};

/** The same nocturne in its final seconds. */
const TRACK_TAIL = { ...MOCK_PLAYBACK, remaining_seconds: 3, remaining_ms: 3000 };

/**
 * The committed nocturne has finished and the repeating playlist has started
 * another. This — not a countdown window — is what ends the wait.
 */
const NEXT_NOCTURNE: SpotifyPlayback = {
  ...MOCK_PLAYBACK,
  track_id: 'chopin-b',
  track_name: 'Nocturne Op. 27 No. 2',
  remaining_seconds: 240,
  remaining_ms: 240000,
};

/** What Spotify reports once the switch has genuinely landed. */
const WHITE_NOISE_PLAYING: SpotifyPlayback = {
  ...MOCK_PLAYBACK,
  track_id: 'rain-1',
  context_uri: WHITENOISE_PLAYLIST,
  track_name: 'Rain on a tent',
  artist_name: 'Sleep Sounds',
  remaining_seconds: 3600,
  remaining_ms: 3600000,
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
// 1. Basic lifecycle
// ---------------------------------------------------------------------------

it('initial state is { status: idle, lastReading: null, nowPlaying: null, error: null }', async () => {
  const owlet = makeOwlet([]);
  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  expect(result.current.state).toEqual({
    status: 'idle',
    lastReading: null,
    nowPlaying: null,
    waitingFor: null,
    error: null,
  });
});

it('start() transitions status to running', async () => {
  const owlet = makeOwlet([]);
  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  expect(result.current.state.status).toBe('running');
});

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

it('null heart_rate (sock off) does not trigger sleep transition, status stays running', async () => {
  const owlet = makeOwlet([{ heart_rate: null, sock_off: true }]);
  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();

  expect(result.current.state.status).toBe('running');
  expect(result.current.state.lastReading?.heart_rate).toBeNull();
});

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
// 2. Sleep detection must be VISIBLE.
//
//    The reported bug: HR drops and the app lands on the Done screen without
//    ever showing the transition. That happened because TRANSITIONING and DONE
//    were dispatched inside a single tick, so no render ever observed
//    'transitioning' and MonitoringScreen navigated away immediately.
//
//    Sleep detection now only ever locks in the transition. Nothing else
//    happens on that tick.
// ---------------------------------------------------------------------------

it('shows transitioning as soon as HR drops, and does not touch playback on that tick', async () => {
  const owlet = makeOwlet([{ heart_rate: 90 }]);
  mockGetCurrentPlayback.mockResolvedValue(MOCK_PLAYBACK);

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();

  expect(result.current.state.status).toBe('transitioning');
  expect(mockStartPlaylist).not.toHaveBeenCalled();
});

it('never reaches done in the same tick that detected sleep, whatever Spotify reports', async () => {
  // Every one of these used to short-circuit the wait and land on done inside
  // the detection tick.
  const cases: Array<[string, SpotifyPlayback | null]> = [
    ['nothing playing', null],
    ['paused', { ...MOCK_PLAYBACK, is_playing: false }],
    ['already at the tail', TRACK_TAIL],
    ['mid-track', MOCK_PLAYBACK],
  ];

  for (const [, playback] of cases) {
    jest.resetAllMocks();
    mockGetCurrentPlayback.mockResolvedValue(playback);
    mockFindDeviceByName.mockResolvedValue('dev1');
    mockStartPlaylist.mockResolvedValue(true);
    mockGetValidToken.mockResolvedValue(null);
    mockStartService.mockResolvedValue(true);

    const seen: string[] = [];
    const owlet = makeOwlet([{ heart_rate: 90 }]);
    const { result } = await renderHook(() => {
      const routine = useRoutine(owlet, MOCK_TOKENS, 'iphone');
      seen.push(routine.state.status);
      return routine;
    });

    await act(async () => {
      result.current.start();
    });
    await advanceInterval();

    expect(result.current.state.status).toBe('transitioning');
    expect(seen).toContain('transitioning');
    expect(seen).not.toContain('done');
  }
});

// ---------------------------------------------------------------------------
// 3. Waiting out the committed nocturne.
//
//    The routine commits to the track playing at sleep detection and waits for
//    THAT track to finish. Nothing else ends the wait.
// ---------------------------------------------------------------------------

it('waits out the committed nocturne, then switches once it has run its length', async () => {
  // Committed to a nocturne with 12s left, so the wait spans a few polls.
  const owlet = makeOwlet([{ heart_rate: 90 }]);
  mockGetCurrentPlayback
    .mockResolvedValueOnce({ ...MOCK_PLAYBACK, remaining_seconds: 12, remaining_ms: 12000 })
    .mockResolvedValueOnce({ ...MOCK_PLAYBACK, remaining_seconds: 7, remaining_ms: 7000 })
    .mockResolvedValueOnce({ ...MOCK_PLAYBACK, remaining_seconds: 2, remaining_ms: 2000 })
    .mockResolvedValueOnce(NEXT_NOCTURNE)
    .mockResolvedValue(WHITE_NOISE_PLAYING);

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval(); // sleep detected, nocturne committed
  expect(result.current.state.status).toBe('transitioning');
  expect(result.current.state.waitingFor).toBe('Nocturne Op. 9 No. 2');

  await advanceInterval(); // 7s to go — the nocturne is not over
  expect(mockStartPlaylist).not.toHaveBeenCalled();

  await advanceInterval(); // 2s to go — still not over
  expect(mockStartPlaylist).not.toHaveBeenCalled();
  expect(result.current.state.status).toBe('transitioning');

  await advanceInterval(); // the nocturne has run its length — white noise goes on
  expect(mockStartPlaylist).toHaveBeenCalledWith(
    MOCK_TOKENS.access_token,
    WHITENOISE_PLAYLIST,
    'speaker-1',
  );

  await advanceInterval(); // Spotify confirms it
  expect(result.current.state.status).toBe('done');
});

it('switches when the playlist has moved on to a different track', async () => {
  const owlet = makeOwlet([{ heart_rate: 90 }]);
  mockGetCurrentPlayback
    .mockResolvedValueOnce(MOCK_PLAYBACK)
    .mockResolvedValueOnce({ ...MOCK_PLAYBACK, track_id: 'chopin-b', remaining_seconds: 240 })
    .mockResolvedValue(WHITE_NOISE_PLAYING);

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();
  await advanceInterval();

  expect(mockStartPlaylist).toHaveBeenCalledWith(
    MOCK_TOKENS.access_token,
    WHITENOISE_PLAYLIST,
    'speaker-1',
  );
});

it('starts white noise on the device the music is playing on, not a name the user typed', async () => {
  const owlet = makeOwlet([{ heart_rate: 90 }]);
  mockGetCurrentPlayback
    .mockResolvedValueOnce({ ...MOCK_PLAYBACK, device_id: 'kitchen-hifi' })
    .mockResolvedValueOnce({ ...NEXT_NOCTURNE, device_id: 'kitchen-hifi' })
    .mockResolvedValue(WHITE_NOISE_PLAYING);

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();
  await advanceInterval();

  expect(mockStartPlaylist).toHaveBeenCalledWith(
    MOCK_TOKENS.access_token,
    WHITENOISE_PLAYLIST,
    'kitchen-hifi',
  );
  expect(mockFindDeviceByName).not.toHaveBeenCalled();
});

it('does not restart Chopin once the transition is locked in, even if HR climbs back', async () => {
  const owlet = makeOwlet([{ heart_rate: 90 }, { heart_rate: 135 }]);
  mockGetCurrentPlayback
    .mockResolvedValueOnce(MOCK_PLAYBACK)
    .mockResolvedValueOnce(NEXT_NOCTURNE)
    .mockResolvedValue(WHITE_NOISE_PLAYING);

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();
  await advanceInterval();
  await advanceInterval();

  expect(mockStartPlaylist).not.toHaveBeenCalledWith(
    expect.anything(),
    CHOPIN_PLAYLIST,
    expect.anything(),
  );
});

// ---------------------------------------------------------------------------
// 4. Missing samples are not signals.
//
//    This is the regression that broke the app. `/me/player` returns 204 all
//    the time, and Spotify reports is_playing:false for a moment after any play
//    call. Either one used to end the wait instantly.
// ---------------------------------------------------------------------------

it('keeps waiting through a transient 204 mid-nocturne', async () => {
  const owlet = makeOwlet([{ heart_rate: 90 }]);
  mockGetCurrentPlayback
    .mockResolvedValueOnce(MOCK_PLAYBACK)
    .mockResolvedValueOnce(null) // the blip that used to cut the nocturne short
    .mockResolvedValue({ ...MOCK_PLAYBACK, remaining_seconds: 195, remaining_ms: 195000 });

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();
  await advanceInterval();
  await advanceInterval();

  expect(result.current.state.status).toBe('transitioning');
  expect(mockStartPlaylist).not.toHaveBeenCalled();
});

it('keeps waiting through a single paused sample mid-nocturne', async () => {
  const owlet = makeOwlet([{ heart_rate: 90 }]);
  mockGetCurrentPlayback
    .mockResolvedValueOnce(MOCK_PLAYBACK)
    .mockResolvedValueOnce({ ...MOCK_PLAYBACK, is_playing: false })
    .mockResolvedValue({ ...MOCK_PLAYBACK, remaining_seconds: 195, remaining_ms: 195000 });

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();
  await advanceInterval();
  await advanceInterval();

  expect(result.current.state.status).toBe('transitioning');
  expect(mockStartPlaylist).not.toHaveBeenCalled();
});

it('does switch once the silence is sustained rather than a blip', async () => {
  const owlet = makeOwlet([{ heart_rate: 90 }]);
  mockGetCurrentPlayback.mockResolvedValueOnce(MOCK_PLAYBACK).mockResolvedValue(null);

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval(); // detection
  for (let poll = 0; poll < BLIND_POLLS_BEFORE_IDLE; poll += 1) {
    expect(mockStartPlaylist).not.toHaveBeenCalled();
    await advanceInterval();
  }

  expect(mockStartPlaylist).toHaveBeenCalledWith(
    MOCK_TOKENS.access_token,
    WHITENOISE_PLAYLIST,
    'speaker-1',
  );
});

it('falls back to the named device when nothing has ever reported one', async () => {
  const owlet = makeOwlet([{ heart_rate: 90 }]);
  mockGetCurrentPlayback.mockResolvedValue(null); // nothing playing, ever

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();
  for (let poll = 0; poll < BLIND_POLLS_BEFORE_IDLE; poll += 1) {
    await advanceInterval();
  }

  expect(mockFindDeviceByName).toHaveBeenCalledWith(MOCK_TOKENS.access_token, 'iphone');
  expect(mockStartPlaylist).toHaveBeenCalledWith(
    MOCK_TOKENS.access_token,
    WHITENOISE_PLAYLIST,
    'dev1',
  );
});

// ---------------------------------------------------------------------------
// 5. The switch is verified against Spotify, not assumed from a status code.
//
//    The second reported bug: the app says done and white noise is not playing.
//    A play call that Spotify merely accepted, or that landed on a device that
//    never woke up, must not be reported as success.
// ---------------------------------------------------------------------------

it('stays transitioning until Spotify confirms white noise is the playing context', async () => {
  const owlet = makeOwlet([{ heart_rate: 90 }]);
  mockGetCurrentPlayback
    .mockResolvedValueOnce(MOCK_PLAYBACK)
    .mockResolvedValueOnce(NEXT_NOCTURNE)                              // switch issued here
    .mockResolvedValueOnce(MOCK_PLAYBACK)                           // Chopin still on — not done
    .mockResolvedValueOnce(MOCK_PLAYBACK)                           // still not done
    .mockResolvedValue(WHITE_NOISE_PLAYING);                        // now it is

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();
  await advanceInterval();
  expect(mockStartPlaylist).toHaveBeenCalledTimes(1);

  await advanceInterval();
  expect(result.current.state.status).toBe('transitioning');

  await advanceInterval();
  expect(result.current.state.status).toBe('transitioning');

  await advanceInterval();
  expect(result.current.state.status).toBe('done');
});

it('retries the play call on every poll until white noise is confirmed', async () => {
  const owlet = makeOwlet([{ heart_rate: 90 }]);
  mockGetCurrentPlayback
    .mockResolvedValueOnce(MOCK_PLAYBACK)
    .mockResolvedValueOnce(NEXT_NOCTURNE)
    .mockResolvedValueOnce(MOCK_PLAYBACK)
    .mockResolvedValue(WHITE_NOISE_PLAYING);

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();
  await advanceInterval();
  expect(mockStartPlaylist).toHaveBeenCalledTimes(1);

  await advanceInterval(); // Chopin still playing — try again
  expect(mockStartPlaylist).toHaveBeenCalledTimes(2);

  await advanceInterval();
  expect(result.current.state.status).toBe('done');
});

it('does not report done when Spotify refuses the play call, and retries', async () => {
  const owlet = makeOwlet([{ heart_rate: 90 }]);
  mockGetCurrentPlayback
    .mockResolvedValueOnce(MOCK_PLAYBACK)
    .mockResolvedValueOnce(NEXT_NOCTURNE)
    .mockResolvedValue(WHITE_NOISE_PLAYING);
  mockStartPlaylist.mockResolvedValueOnce(false).mockResolvedValue(true);

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();
  await advanceInterval();

  expect(result.current.state.status).toBe('transitioning');
  expect(result.current.state.error).toBeTruthy();

  // Spotify said no, but the next poll shows white noise playing anyway — which
  // is exactly what a woken-up device looks like. What is playing decides.
  await advanceInterval();
  expect(result.current.state.status).toBe('done');
  expect(mockStartPlaylist).toHaveBeenCalledTimes(1);
});

it('does not report done when the named device cannot be found, and retries', async () => {
  const owlet = makeOwlet([{ heart_rate: 90 }]);
  mockGetCurrentPlayback.mockResolvedValue(null);
  mockFindDeviceByName.mockResolvedValueOnce(null).mockResolvedValue('dev1');

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();
  for (let poll = 0; poll < BLIND_POLLS_BEFORE_IDLE; poll += 1) {
    await advanceInterval();
  }

  expect(result.current.state.status).toBe('transitioning');
  expect(result.current.state.error).toMatch(/device/i);

  mockGetCurrentPlayback.mockResolvedValue(WHITE_NOISE_PLAYING);
  await advanceInterval();

  expect(result.current.state.status).toBe('done');
});

it('keeps the foreground service alive while a failed switch is still retrying', async () => {
  const owlet = makeOwlet([{ heart_rate: 90 }]);
  mockGetCurrentPlayback.mockResolvedValueOnce(MOCK_PLAYBACK).mockResolvedValue(NEXT_NOCTURNE);
  mockStartPlaylist.mockResolvedValue(false);

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();
  await advanceInterval();

  expect(result.current.state.status).toBe('transitioning');
  expect(mockStopService).not.toHaveBeenCalled();
});

it('stops the foreground service once white noise is confirmed', async () => {
  const owlet = makeOwlet([{ heart_rate: 90 }]);
  mockGetCurrentPlayback
    .mockResolvedValueOnce(MOCK_PLAYBACK)
    .mockResolvedValueOnce(NEXT_NOCTURNE)
    .mockResolvedValue(WHITE_NOISE_PLAYING);

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();
  await advanceInterval();
  await advanceInterval();

  expect(result.current.state.status).toBe('done');
  expect(mockStopService).toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// 6. Keeping the lullaby going while the baby is awake
// ---------------------------------------------------------------------------

it('restarts Chopin when the track is ending and the baby is still awake', async () => {
  const owlet = makeOwlet([{ heart_rate: 130 }]);
  mockGetCurrentPlayback.mockResolvedValue({ ...MOCK_PLAYBACK, remaining_seconds: 2, remaining_ms: 2000 });

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();

  // Restarted on the device the music is coming out of, not a typed-in name.
  expect(mockStartPlaylist).toHaveBeenCalledWith(
    MOCK_TOKENS.access_token,
    CHOPIN_PLAYLIST,
    'speaker-1',
  );
});

it('falls back to the named device to restart Chopin when nothing is playing', async () => {
  const owlet = makeOwlet([{ heart_rate: 130 }]);
  mockGetCurrentPlayback.mockResolvedValue(null);

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();

  expect(mockStartPlaylist).toHaveBeenCalledWith(
    MOCK_TOKENS.access_token,
    CHOPIN_PLAYLIST,
    'dev1',
  );
});

it('leaves Chopin alone mid-track while the baby is awake', async () => {
  const owlet = makeOwlet([{ heart_rate: 130 }]);
  mockGetCurrentPlayback.mockResolvedValue(MOCK_PLAYBACK);

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();

  expect(mockStartPlaylist).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// 7. monitorOnly
// ---------------------------------------------------------------------------

it('monitorOnly: HR below threshold keeps status running and never calls startPlaylist', async () => {
  const owlet = makeOwlet([{ heart_rate: 90 }]);
  mockGetCurrentPlayback.mockResolvedValue(TRACK_TAIL);

  const { result } = await renderHook(() =>
    useRoutine(owlet, MOCK_TOKENS, 'iphone', POLL_INTERVAL_MS, true),
  );

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();
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
// 8. Live vitals keep flowing through the whole transition
// ---------------------------------------------------------------------------

it('keeps polling live owlet vitals while the transition waits out the track', async () => {
  const owlet = makeOwlet([{ heart_rate: 90 }, { heart_rate: 85 }, { heart_rate: 80 }]);
  mockGetCurrentPlayback
    .mockResolvedValueOnce(MOCK_PLAYBACK)
    .mockResolvedValueOnce({ ...MOCK_PLAYBACK, remaining_seconds: 150, remaining_ms: 150000 })
    .mockResolvedValue({ ...MOCK_PLAYBACK, remaining_seconds: 100, remaining_ms: 100000 });

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();
  expect(result.current.state.lastReading?.heart_rate).toBe(90);

  await advanceInterval();
  expect(result.current.state.status).toBe('transitioning');
  expect(result.current.state.lastReading?.heart_rate).toBe(85);

  await advanceInterval();
  expect(result.current.state.status).toBe('transitioning');
  expect(result.current.state.lastReading?.heart_rate).toBe(80);
});

// ---------------------------------------------------------------------------
// 9. Token refresh — an overnight routine outlives a Spotify access token.
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

it('uses the refreshed token when starting the white-noise playlist', async () => {
  mockGetValidToken.mockResolvedValue('fresh-token');
  const owlet = makeOwlet([{ heart_rate: 90 }]);
  mockGetCurrentPlayback
    .mockResolvedValueOnce(MOCK_PLAYBACK)
    .mockResolvedValueOnce(NEXT_NOCTURNE)
    .mockResolvedValue(WHITE_NOISE_PLAYING);

  const { result } = await renderHook(() =>
    useRoutine(owlet, MOCK_TOKENS, 'iphone', POLL_INTERVAL_MS, false, 'client-id'),
  );

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();
  await advanceInterval();

  expect(mockStartPlaylist).toHaveBeenCalledWith('fresh-token', WHITENOISE_PLAYLIST, 'speaker-1');
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
// 10. Re-entrancy — the Owlet auth chain plus Spotify calls can outrun the poll
//     interval, so ticks must never overlap.
// ---------------------------------------------------------------------------

it('skips a tick while the previous tick is still in flight (no overlapping reads)', async () => {
  let resolveRead!: (r: OwletReading) => void;
  const read = jest
    .fn()
    .mockImplementationOnce(() => new Promise<OwletReading>((res) => { resolveRead = res; }))
    .mockResolvedValue({ ...DEFAULT_READING, heart_rate: 120 });
  const owlet = { read } as unknown as Owlet;

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();
  await advanceInterval();

  expect(read).toHaveBeenCalledTimes(1);

  await act(async () => {
    resolveRead({ ...DEFAULT_READING, heart_rate: 120 });
    await new Promise<void>((r) => setImmediate(r));
  });
});

// ---------------------------------------------------------------------------
// 11. Android foreground service and the tick stream that drives the loop.
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
  mockGetCurrentPlayback.mockResolvedValue(MOCK_PLAYBACK);

  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone'));

  await act(async () => {
    result.current.start();
  });

  await advanceInterval();

  expect(result.current.state.status).toBe('transitioning');
  expect(mockUpdateService).toHaveBeenLastCalledWith(expect.stringMatching(/sleep/i));
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

  await advanceInterval();
  expect(owlet.read).not.toHaveBeenCalled();

  await act(async () => {
    nativeTick?.();
    await new Promise<void>((r) => setImmediate(r));
  });

  expect(owlet.read).toHaveBeenCalledTimes(1);
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
  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'iphone', 7000));

  await act(async () => {
    result.current.start();
  });

  expect(mockStartService).toHaveBeenCalledWith(expect.any(String), expect.any(String), 7000);
});

it('falls back to the JS interval when the service fails to start after subscribing', async () => {
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
