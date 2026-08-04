import { useReducer, useRef, useEffect, useCallback } from 'react';
import type { OwletReading, SpotifyPlayback, SpotifyTokens, RoutineState } from '../lib/types';
import {
  HR_THRESHOLD,
  POLL_INTERVAL_MS,
  RESTART_THRESHOLD_SECONDS,
  CHOPIN_PLAYLIST,
  WHITENOISE_PLAYLIST,
} from '../lib/constants';
import {
  captureTarget,
  evaluateWait,
  isWhiteNoisePlaying,
  type TransitionTarget,
} from '../lib/transition';
import type { Owlet } from '../lib/owlet';
import { getCurrentPlayback, findDeviceByName, startPlaylist } from '../lib/spotifyApi';
import { getValidToken } from '../lib/spotifyAuth';
import {
  startForegroundService,
  updateForegroundService,
  stopForegroundService,
  addTickListener,
  type TickSubscription,
} from '../lib/foregroundService';

type Action =
  | { type: 'START' }
  | { type: 'STOP' }
  | { type: 'READING'; payload: OwletReading }
  | { type: 'NOW_PLAYING'; payload: SpotifyPlayback | null }
  | { type: 'TRANSITIONING'; payload: string | null }
  | { type: 'DONE' }
  | { type: 'ERROR'; payload: string };

// Text for the ongoing notification. Leads with the vitals so the routine can be
// checked from the lock screen without opening the app.
function notificationBody(
  reading: OwletReading,
  waitingFor: TransitionTarget | null,
  transitioning: boolean,
  monitorOnly: boolean,
): string {
  const hr = reading.heart_rate !== null ? `${reading.heart_rate} BPM` : 'No reading';
  if (transitioning) {
    return waitingFor
      ? `${hr} · Sleep detected — white noise after ${waitingFor.trackName}`
      : `${hr} · Sleep detected — starting white noise`;
  }
  if (monitorOnly) return `${hr} · Monitoring only`;
  return `${hr} · Keeping the lullaby going`;
}

// Locks in the transition the first time HR drops below the sleep threshold.
// Once locked, HR is no longer re-evaluated: a brief blip back above the
// threshold must not cancel the switch to white noise.
function shouldLockTransition(
  monitorOnly: boolean,
  alreadyTransitioning: boolean,
  heartRate: number | null,
): boolean {
  return (
    !monitorOnly && !alreadyTransitioning && heartRate !== null && heartRate < HR_THRESHOLD
  );
}

// Puts white noise on. Throws if Spotify did not accept the command, which
// leaves the routine in "transitioning" with the reason on screen and lets the
// next poll try again.
//
// Note what this does NOT do: report the routine finished. A play call that
// Spotify accepted is not the same as white noise coming out of the speaker —
// the device may be asleep, or gone. Only a later poll that sees the white-noise
// playlist as the playing context ends the routine.
async function startWhiteNoise(
  accessToken: string,
  deviceId: string | null,
  deviceName: string,
): Promise<void> {
  const targetDevice = deviceId ?? (await findDeviceByName(accessToken, deviceName));
  if (!targetDevice) {
    throw new Error(`Spotify device "${deviceName}" not found — cannot start white noise`);
  }
  const started = await startPlaylist(accessToken, WHITENOISE_PLAYLIST, targetDevice);
  if (!started) {
    throw new Error('Spotify would not start the white-noise playlist');
  }
}

// Awake: keep the lullaby going — restart it when the track is ending or nothing
// is playing. Prefers the device the music is genuinely coming out of, falling
// back to the name the user typed only when there is no playback to ask.
async function restartLullabyIfEnding(
  accessToken: string,
  playback: SpotifyPlayback | null,
  deviceName: string,
): Promise<void> {
  const remainingSeconds = playback?.remaining_seconds ?? null;
  const trackEnding = remainingSeconds === null || remainingSeconds < RESTART_THRESHOLD_SECONDS;
  if (!trackEnding) return;

  const deviceId = playback?.device_id || (await findDeviceByName(accessToken, deviceName));
  if (deviceId) {
    await startPlaylist(accessToken, CHOPIN_PLAYLIST, deviceId);
  }
}

const initialState: RoutineState = {
  status: 'idle',
  lastReading: null,
  nowPlaying: null,
  waitingFor: null,
  error: null,
};

function reducer(state: RoutineState, action: Action): RoutineState {
  switch (action.type) {
    case 'START':
      return { ...state, status: 'running', waitingFor: null, error: null };
    case 'STOP':
      return { ...state, status: 'idle', waitingFor: null };
    case 'READING':
      return { ...state, lastReading: action.payload };
    case 'NOW_PLAYING':
      return { ...state, nowPlaying: action.payload };
    case 'TRANSITIONING':
      return { ...state, status: 'transitioning', waitingFor: action.payload };
    case 'DONE':
      return { ...state, status: 'done', waitingFor: null };
    case 'ERROR':
      return { ...state, error: action.payload };
    default:
      return state;
  }
}

export function useRoutine(
  owlet: Owlet | null,
  tokens: SpotifyTokens | null,
  deviceName: string,
  pollIntervalMs: number = POLL_INTERVAL_MS,
  monitorOnly: boolean = false,
  clientId: string = '',
): {
  state: RoutineState;
  start: () => void;
  stop: () => void;
} {
  const [state, dispatch] = useReducer(reducer, initialState);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Guards against overlapping ticks: the Owlet auth chain + Spotify calls can
  // take longer than the poll interval, so a second tick would otherwise fire
  // while the first is still running. While a tick is in flight, later ticks
  // are skipped.
  const tickingRef = useRef(false);
  // Set once HR drops below the sleep threshold, and never cleared until the
  // routine restarts. From then on the routine has one job: wait out the
  // committed nocturne, then get white noise playing.
  const transitionRef = useRef(false);
  // The nocturne the routine committed to at sleep detection.
  const targetRef = useRef<TransitionTarget | null>(null);
  // Consecutive polls that told us nothing about the music.
  const blindPollsRef = useRef(0);
  // Set once the play call has been issued at least once. From then on every
  // poll checks whether white noise is genuinely playing, and re-issues the
  // call until it is.
  const switchIssuedRef = useRef(false);

  // Set when the native service is driving the loop instead of setInterval.
  const tickSubscriptionRef = useRef<TickSubscription | null>(null);

  const resetTransition = useCallback(() => {
    transitionRef.current = false;
    targetRef.current = null;
    blindPollsRef.current = 0;
    switchIssuedRef.current = false;
  }, []);

  const clearPolling = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (tickSubscriptionRef.current !== null) {
      tickSubscriptionRef.current.remove();
      tickSubscriptionRef.current = null;
    }
  }, []);

  // One poll's worth of transition work: either still waiting out the committed
  // nocturne, or chasing confirmation that white noise is playing.
  const advanceTransition = useCallback(
    async (accessToken: string, playback: SpotifyPlayback | null) => {
      if (switchIssuedRef.current) {
        if (isWhiteNoisePlaying(playback)) {
          clearPolling();
          // Only now: while the switch is still unconfirmed the routine needs
          // the OS to leave it alone.
          stopForegroundService();
          dispatch({ type: 'DONE' });
          return;
        }
        // Spotify accepted the call but the room is not playing white noise.
        // Try again on this poll rather than waiting for anything.
        await startWhiteNoise(
          accessToken,
          playback?.device_id ?? targetRef.current?.deviceId ?? null,
          deviceName,
        );
        return;
      }

      const verdict = evaluateWait(targetRef.current, playback, Date.now(), blindPollsRef.current);
      targetRef.current = verdict.target;
      blindPollsRef.current = verdict.blindPolls;
      if (!verdict.switchNow) return;

      switchIssuedRef.current = true;
      await startWhiteNoise(accessToken, verdict.deviceId, deviceName);
    },
    [clearPolling, deviceName],
  );

  const tick = useCallback(async () => {
    if (!owlet || !tokens) return;
    if (tickingRef.current) return;
    tickingRef.current = true;

    try {
      const reading = await owlet.read();
      dispatch({ type: 'READING', payload: reading });

      // Spotify access tokens expire after ~1 hour; an overnight monitor runs far
      // longer than that. Refresh before every Spotify call so a stale token never
      // reaches the API. Falls back to the passed-in token when no client
      // credentials are available (e.g. mock mode).
      let accessToken = tokens.access_token;
      if (clientId) {
        const valid = await getValidToken(clientId);
        if (valid) accessToken = valid;
      }

      const playback = await getCurrentPlayback(accessToken);
      dispatch({ type: 'NOW_PLAYING', payload: playback });

      // Sleep detected. Commit to the nocturne that is playing right now — from
      // here on, "has the transition happened yet" means "has THAT track
      // finished", and nothing else.
      const justLocked = shouldLockTransition(monitorOnly, transitionRef.current, reading.heart_rate);
      if (justLocked) {
        transitionRef.current = true;
        targetRef.current = captureTarget(playback, Date.now());
        // A detection poll that saw no music is itself the first blind poll.
        blindPollsRef.current = targetRef.current ? 0 : 1;
        dispatch({ type: 'TRANSITIONING', payload: targetRef.current?.trackName ?? null });
      }

      // Keep the ongoing notification in step with the routine. While the app is
      // backgrounded this is the only visible sign that polling is still alive —
      // if the text stops advancing, the OS has frozen the loop.
      updateForegroundService(
        notificationBody(reading, targetRef.current, transitionRef.current, monitorOnly),
      );

      if (monitorOnly) return;
      // The detection poll does nothing but announce itself. The transition has
      // to be a state the screen can actually render before anything acts on it,
      // and the committed nocturne has only just started being waited out.
      if (justLocked) return;

      if (transitionRef.current) {
        await advanceTransition(accessToken, playback);
        return;
      }

      await restartLullabyIfEnding(accessToken, playback, deviceName);
    } catch (err) {
      dispatch({ type: 'ERROR', payload: err instanceof Error ? err.message : String(err) });
    } finally {
      tickingRef.current = false;
    }
  }, [owlet, tokens, deviceName, monitorOnly, clientId, advanceTransition]);

  const start = useCallback(() => {
    resetTransition();
    dispatch({ type: 'START' });

    const startInterval = () => {
      if (intervalRef.current === null) {
        intervalRef.current = setInterval(tick, pollIntervalMs);
      }
    };

    // Prefer the service's own tick stream. React Native drops its timer
    // callback in onHostPause, so a setInterval here stops the moment the app
    // leaves the screen — the native loop runs on the main looper under the
    // service's wake lock and keeps firing with the screen off. The interval
    // stays as the fallback wherever the native service does not exist.
    const subscription = addTickListener(() => {
      void tick();
    });
    if (subscription) {
      tickSubscriptionRef.current = subscription;
    } else {
      startInterval();
    }

    // Android freezes JS timers for a backgrounded app (Doze, or an OEM
    // background killer), which would stop the polling loop the moment the phone
    // is put down — and with it the transition. A foreground service keeps the
    // process alive and out of Doze for as long as the routine runs.
    void startForegroundService('Babu', 'Starting the bedtime routine…', pollIntervalMs).then(
      (running) => {
        // Subscribed to a tick stream that will never emit — the module is
        // present but the service did not start. Polling nothing at all is worse
        // than not having the service, so take the interval after all.
        // A null subscription here means stop() already ran; leave it stopped.
        if (!running && tickSubscriptionRef.current !== null) {
          tickSubscriptionRef.current.remove();
          tickSubscriptionRef.current = null;
          startInterval();
        }
      },
    );
  }, [tick, pollIntervalMs, resetTransition]);

  const stop = useCallback(() => {
    clearPolling();
    stopForegroundService();
    resetTransition();
    dispatch({ type: 'STOP' });
  }, [clearPolling, resetTransition]);

  useEffect(() => {
    return () => {
      clearPolling();
      // The service exists to protect this loop; if the loop is gone, so is its
      // reason to hold the process open.
      stopForegroundService();
    };
  }, [clearPolling]);

  return { state, start, stop };
}
