import { useReducer, useRef, useEffect, useCallback } from 'react';
import type { OwletReading, SpotifyPlayback, SpotifyTokens, RoutineState } from '../lib/types';
import {
  HR_THRESHOLD,
  POLL_INTERVAL_MS,
  RESTART_THRESHOLD_SECONDS,
  CHOPIN_PLAYLIST,
  WHITENOISE_PLAYLIST,
} from '../lib/constants';
import type { Owlet } from '../lib/owlet';
import { getCurrentPlayback, findDeviceByName, startPlaylist } from '../lib/spotifyApi';
import { getValidToken } from '../lib/spotifyAuth';

type Action =
  | { type: 'START' }
  | { type: 'STOP' }
  | { type: 'READING'; payload: OwletReading }
  | { type: 'NOW_PLAYING'; payload: SpotifyPlayback | null }
  | { type: 'TRANSITIONING' }
  | { type: 'DONE' }
  | { type: 'ERROR'; payload: string };

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

  const clearPolling = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  // Switches to the white-noise playlist. Called from within a tick (serialized
  // by tickingRef) the moment a live poll shows the current Chopin track in its
  // final seconds — see tick() for why this is poll-driven rather than timed.
  const completeTransition = useCallback(async (accessToken: string) => {
    const deviceId = await findDeviceByName(accessToken, deviceName);
    if (deviceId) {
      await startPlaylist(accessToken, WHITENOISE_PLAYLIST, deviceId);
    }
    clearPolling();
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

      if (monitorOnly) return;

      // Lock in the transition the first time HR drops below the sleep threshold.
      // Once locked, HR is no longer re-evaluated: a brief blip back above the
      // threshold must not cancel the switch to white noise.
      if (
        !transitionRef.current &&
        reading.heart_rate !== null &&
        reading.heart_rate < HR_THRESHOLD
      ) {
        transitionRef.current = true;
        dispatch({ type: 'TRANSITIONING' });
      }

      // `remaining_seconds` is a live query against Spotify made on THIS tick, so
      // it reflects the track's real position right now. Both branches below key
      // off "is the current track in its final seconds (or nothing playing)?".
      const remainingSeconds = playback?.remaining_seconds ?? null;
      const trackEnding =
        remainingSeconds === null || remainingSeconds < RESTART_THRESHOLD_SECONDS;

      if (transitionRef.current) {
        // Sleep detected. Let the current Chopin track wind down, then switch to
        // white noise — but do it while the track is still in its final seconds,
        // BEFORE the repeating playlist auto-advances to a fresh Chopin track.
        //
        // This is deliberately poll-driven, not a one-shot setTimeout seeded with
        // the remaining_seconds captured at sleep-detection time. That timer
        // approach cannot hit the boundary: the snapshot ages by network latency
        // and the playlist auto-advances, so the switch reliably landed a few
        // seconds INTO the next Chopin track. Deciding from each fresh poll and
        // switching before the boundary eliminates that bleed entirely. We never
        // restart Chopin once transitioning.
        if (trackEnding && !switchingRef.current) {
          switchingRef.current = true;
          try {
            await completeTransition(accessToken);
          } catch (err) {
            // Let a later poll retry the switch if this attempt failed.
            switchingRef.current = false;
            throw err;
          }
        }
        return;
      }

      // Awake: keep Chopin alive — restart it when the track is ending or nothing
      // is playing.
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
    dispatch({ type: 'START' });
    intervalRef.current = setInterval(tick, pollIntervalMs);
  }, [tick, pollIntervalMs]);

  const stop = useCallback(() => {
    clearPolling();
    transitionRef.current = false;
    switchingRef.current = false;
    dispatch({ type: 'STOP' });
  }, [clearPolling]);

  useEffect(() => {
    return () => {
      clearPolling();
    };
  }, [clearPolling]);

  return { state, start, stop };
}
