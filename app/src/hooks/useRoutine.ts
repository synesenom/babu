import { useReducer, useRef, useEffect, useCallback } from 'react';
import type { OwletReading, SpotifyPlayback, SpotifyTokens, RoutineState } from '../lib/types';
import {
  HR_THRESHOLD,
  POLL_INTERVAL_MS,
  RESTART_THRESHOLD_SECONDS,
  TRANSITION_TAIL_SECONDS,
  CHOPIN_PLAYLIST,
  WHITENOISE_PLAYLIST,
} from '../lib/constants';
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
  | { type: 'TRANSITIONING' }
  | { type: 'DONE' }
  | { type: 'ERROR'; payload: string };

// Text for the ongoing notification. Leads with the vitals so the routine can be
// checked from the lock screen without opening the app.
function notificationBody(
  reading: OwletReading,
  transitioning: boolean,
  monitorOnly: boolean,
): string {
  const hr = reading.heart_rate !== null ? `${reading.heart_rate} BPM` : 'No reading';
  if (transitioning) return `${hr} · Sleep detected — white noise at the end of the track`;
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

// The switch to white noise is due when ANY of these holds, and once due it
// stays due:
//   nothing is playing, or playback is paused — there is no track left to
//   wind down, and a paused player would hold remaining_seconds steady
//   forever;
//   the current track is inside the tail window — the normal, clean case:
//   white noise starts before the playlist auto-advances;
//   a boundary passed between two polls (the playlist advanced to another
//   track, or the same one restarted and the position jumped backwards).
//   The tail was missed; switching now costs a few seconds of a fresh
//   nocturne, which beats waiting for a window we may never see.
function isSwitchDue(
  playback: SpotifyPlayback | null,
  previous: { trackName: string; remainingSeconds: number } | null,
  remainingSeconds: number | null,
): boolean {
  const nothingToWaitFor = playback === null || !playback.is_playing;
  const inTail = remainingSeconds !== null && remainingSeconds <= TRANSITION_TAIL_SECONDS;
  const boundaryMissed =
    playback !== null &&
    previous !== null &&
    (playback.track_name !== previous.trackName ||
      playback.remaining_seconds > previous.remainingSeconds + 1);
  return nothingToWaitFor || inTail || boundaryMissed;
}

// Starts the white-noise playlist on the named device. Throws if white noise
// did not actually start — the caller must never report "done" on a switch
// that silently did nothing.
async function startWhiteNoise(accessToken: string, deviceName: string): Promise<void> {
  const deviceId = await findDeviceByName(accessToken, deviceName);
  if (!deviceId) {
    throw new Error(`Spotify device "${deviceName}" not found — cannot start white noise`);
  }
  const started = await startPlaylist(accessToken, WHITENOISE_PLAYLIST, deviceId);
  if (!started) {
    throw new Error('Spotify would not start the white-noise playlist');
  }
}

const initialState: RoutineState = {
  status: 'idle',
  lastReading: null,
  nowPlaying: null,
  error: null,
};

function reducer(state: RoutineState, action: Action): RoutineState {
  switch (action.type) {
    case 'START':
      return { ...state, status: 'running', error: null };
    case 'STOP':
      return { ...state, status: 'idle' };
    case 'READING':
      return { ...state, lastReading: action.payload };
    case 'NOW_PLAYING':
      return { ...state, nowPlaying: action.payload };
    case 'TRANSITIONING':
      return { ...state, status: 'transitioning' };
    case 'DONE':
      return { ...state, status: 'done' };
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
  // take longer than the poll interval, so setInterval would otherwise fire a
  // second tick while the first is still running. That race let a stale tick
  // restart Chopin after a transition had already begun, so the routine showed
  // "transitioning" but never switched to white noise. While a tick is in
  // flight, later ticks are skipped.
  const tickingRef = useRef(false);
  // Set once HR drops below the sleep threshold. From then on every tick stops
  // evaluating HR / restarting Chopin and instead only waits for the current
  // track to reach its tail before switching to white noise.
  const transitionRef = useRef(false);
  // Set once the white-noise switch has been kicked off, so a later tick that
  // races the switch cannot fire it a second time.
  const switchingRef = useRef(false);
  // Set once the routine has decided the switch is due. It never goes back to
  // false: an attempt that fails (device gone, Spotify refuses the play call)
  // must be retried on the very next poll, not sent back to waiting for a track
  // tail that may already have passed.
  const switchDueRef = useRef(false);
  // The playback seen on the previous transitioning poll, used to notice that a
  // track boundary passed between two polls.
  const lastPlaybackRef = useRef<{ trackName: string; remainingSeconds: number } | null>(null);

  // Set when the native service is driving the loop instead of setInterval.
  const tickSubscriptionRef = useRef<TickSubscription | null>(null);

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

  // Switches to the white-noise playlist. Called from within a tick (serialized
  // by tickingRef) once the switch is due — see tick() for how that is decided.
  //
  // Throws if white noise did not actually start. The routine must never report
  // "done" on a switch that silently did nothing: that stops the polling and
  // sends the app to the Done screen while Chopin (or silence) plays on, which
  // is indistinguishable from the transition never happening. Throwing keeps the
  // routine in "transitioning", surfaces the reason, and lets the next poll retry.
  const completeTransition = useCallback(async (accessToken: string) => {
    await startWhiteNoise(accessToken, deviceName);
    clearPolling();
    // Only now: while a failed switch is still retrying, the routine still needs
    // the OS to leave it alone.
    stopForegroundService();
    dispatch({ type: 'DONE' });
  }, [deviceName, clearPolling]);

  const tick = useCallback(async () => {
    if (!owlet || !tokens) return;
    if (tickingRef.current) return;
    tickingRef.current = true;

    try {
      const reading = await owlet.read();
      dispatch({ type: 'READING', payload: reading });

      // Spotify access tokens expire after ~1 hour; an overnight monitor runs far
      // longer than that. Refresh before every Spotify call so a stale token never
      // reaches the API (the cause of the daily 403). Falls back to the passed-in
      // token when no client credentials are available (e.g. mock mode).
      let accessToken = tokens.access_token;
      if (clientId) {
        const valid = await getValidToken(clientId);
        if (valid) accessToken = valid;
      }

      const playback = await getCurrentPlayback(accessToken);
      dispatch({ type: 'NOW_PLAYING', payload: playback });

      // Lock in the transition the first time HR drops below the sleep threshold.
      // Once locked, HR is no longer re-evaluated: a brief blip back above the
      // threshold must not cancel the switch to white noise.
      if (shouldLockTransition(monitorOnly, transitionRef.current, reading.heart_rate)) {
        transitionRef.current = true;
        dispatch({ type: 'TRANSITIONING' });
      }

      // Keep the ongoing notification in step with the routine. While the app is
      // backgrounded this is the only visible sign that polling is still alive —
      // if the text stops advancing, the OS has frozen the loop.
      updateForegroundService(notificationBody(reading, transitionRef.current, monitorOnly));

      if (monitorOnly) return;

      // `remaining_seconds` is a live query against Spotify made on THIS tick, so
      // it reflects the track's real position right now.
      const remainingSeconds = playback?.remaining_seconds ?? null;

      if (transitionRef.current) {
        // Sleep detected. Let the current Chopin track wind down, then switch to
        // white noise — ideally while the track is still in its final seconds,
        // BEFORE the repeating playlist auto-advances to a fresh Chopin track.
        //
        // This is deliberately poll-driven, not a one-shot setTimeout seeded with
        // the remaining_seconds captured at sleep-detection time. That timer
        // approach cannot hit the boundary: the snapshot ages by network latency
        // and the playlist auto-advances, so the switch reliably landed a few
        // seconds INTO the next Chopin track.
        //
        // But a poll-driven switch gated *only* on the tail is just as broken in
        // the other direction: it gets one chance per track, and if no poll lands
        // inside the window the routine waits out another entire nocturne and
        // rolls the dice again — the "stuck in transitioning, white noise never
        // starts" bug. Ticks slower than the poll interval are skipped by the
        // in-flight guard, so missing the window is routine, not exceptional.
        //
        // The switch is due when isSwitchDue() holds, and once due it stays due:
        const previous = lastPlaybackRef.current;
        lastPlaybackRef.current = playback
          ? { trackName: playback.track_name, remainingSeconds: playback.remaining_seconds }
          : null;

        if (isSwitchDue(playback, previous, remainingSeconds)) {
          switchDueRef.current = true;
        }

        if (switchDueRef.current && !switchingRef.current) {
          switchingRef.current = true;
          try {
            await completeTransition(accessToken);
          } catch (err) {
            // Let the next poll retry the switch. switchDueRef stays true, so the
            // retry is immediate rather than waiting for another track tail.
            switchingRef.current = false;
            throw err;
          }
        }
        return;
      }

      // Awake: keep Chopin alive — restart it when the track is ending or nothing
      // is playing.
      const trackEnding =
        remainingSeconds === null || remainingSeconds < RESTART_THRESHOLD_SECONDS;
      if (trackEnding) {
        const deviceId = await findDeviceByName(accessToken, deviceName);
        if (deviceId) {
          await startPlaylist(accessToken, CHOPIN_PLAYLIST, deviceId);
        }
      }
    } catch (err) {
      dispatch({ type: 'ERROR', payload: err instanceof Error ? err.message : String(err) });
    } finally {
      tickingRef.current = false;
    }
  }, [owlet, tokens, deviceName, monitorOnly, clientId, completeTransition]);

  const start = useCallback(() => {
    transitionRef.current = false;
    switchingRef.current = false;
    switchDueRef.current = false;
    lastPlaybackRef.current = null;
    // Android freezes JS timers for a backgrounded app (Doze, or an OEM
    // background killer), which would stop the polling loop the moment the phone
    // is put down — and with it the transition. A foreground service keeps the
    // process alive and out of Doze for as long as the routine runs. Fire and
    // forget: if it cannot start, the routine still runs while the app is on
    // screen, which is strictly what it did before.
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
  }, [tick, pollIntervalMs]);

  const stop = useCallback(() => {
    clearPolling();
    stopForegroundService();
    transitionRef.current = false;
    switchingRef.current = false;
    switchDueRef.current = false;
    lastPlaybackRef.current = null;
    dispatch({ type: 'STOP' });
  }, [clearPolling]);

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
