/**
 * End-to-end check of the whole transition against the REAL spotifyApi and the
 * REAL transition module — only the sock, the OS service and the token refresh
 * are stubbed. Mock mode's playback model stands in for Spotify.
 *
 * The unit tests all mock spotifyApi, so they verify the routine against a model
 * of Spotify rather than the code that talks to it. That gap is exactly how a
 * fully green suite shipped a broken transition. This test closes it: nothing
 * here can pass by agreeing with a mock's opinion of what Spotify does.
 */
import { renderHook, act } from '@testing-library/react-native';
import { useRoutine } from '../useRoutine';
import { resetMockPlayback } from '../../lib/spotifyApi';
import * as spotifyAuth from '../../lib/spotifyAuth';
import * as foregroundService from '../../lib/foregroundService';
import { MOCK_TOKEN } from '../../lib/constants';
import type { OwletReading, SpotifyTokens } from '../../lib/types';
import type { Owlet } from '../../lib/owlet';

jest.mock('../../lib/owlet');
jest.mock('../../lib/spotifyAuth');
jest.mock('../../lib/foregroundService');

const MOCK_TOKENS: SpotifyTokens = {
  access_token: MOCK_TOKEN,
  refresh_token: 'mock-refresh',
  expires_at: Date.now() + 86_400_000,
};

const AWAKE_POLLS = 2;
const POLL_MS = 500;

function sleepingOwlet(): Owlet {
  let ticks = 0;
  return {
    read: async (): Promise<OwletReading> => {
      ticks += 1;
      return {
        heart_rate: ticks <= AWAKE_POLLS ? 130 : 90,
        oxygen: 98,
        battery: 80,
        movement: 'still',
        sock_off: false,
        sock_connected: true,
        base_on: true,
        charging: false,
        dsn: 'mock-dsn',
        timestamp: '2024-01-01 00:00:00',
        raw: {},
      };
    },
  } as unknown as Owlet;
}

async function poll(times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      jest.advanceTimersByTime(POLL_MS);
      await new Promise<void>((r) => setImmediate(r));
    });
  }
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  jest.resetAllMocks();
  resetMockPlayback();
  (spotifyAuth.getValidToken as jest.Mock).mockResolvedValue(null);
  (foregroundService.startForegroundService as jest.Mock).mockResolvedValue(true);
  (foregroundService.addTickListener as jest.Mock).mockReturnValue(null);
});

afterEach(() => {
  jest.useRealTimers();
});

it('runs the whole routine: awake → sleep detected → waits → white noise confirmed', async () => {
  const statuses: string[] = [];
  const owlet = sleepingOwlet();

  const { result } = await renderHook(() => {
    const routine = useRoutine(owlet, MOCK_TOKENS, 'mock', POLL_MS);
    statuses.push(routine.state.status);
    return routine;
  });

  await act(async () => {
    result.current.start();
  });

  // Awake: the lullaby is left alone and the routine keeps running.
  await poll(AWAKE_POLLS);
  expect(result.current.state.status).toBe('running');

  // Sleep detected — the transition must become visible before anything acts.
  await poll(1);
  expect(result.current.state.status).toBe('transitioning');
  expect(result.current.state.waitingFor).toBe('Nocturne Op. 9 No. 2');

  // The committed track has 20s to run: the routine waits, it does not switch.
  await poll(10);
  expect(result.current.state.status).toBe('transitioning');

  // Past the end of the committed track, plus polls for the switch and its
  // confirmation.
  await poll(40);

  expect(result.current.state.status).toBe('done');
  expect(result.current.state.nowPlaying?.track_name).toBe('Rain on a tent');
  expect(statuses).toContain('transitioning');
  expect(statuses.indexOf('transitioning')).toBeLessThan(statuses.indexOf('done'));
});

it('never reports done while Chopin is still the playing context', async () => {
  const owlet = sleepingOwlet();
  const { result } = await renderHook(() => useRoutine(owlet, MOCK_TOKENS, 'mock', POLL_MS));

  await act(async () => {
    result.current.start();
  });

  // The committed track runs 20s; at 500ms per poll that is ~43 polls, plus a
  // poll to issue the switch and another to confirm it. Until then, done is not
  // an option — and when it does arrive, white noise must be what is playing.
  for (let i = 0; i < 60; i += 1) {
    await poll(1);
    if (result.current.state.status === 'done') {
      expect(result.current.state.nowPlaying?.track_name).toBe('Rain on a tent');
      return;
    }
  }
  throw new Error('routine never reached done');
});
