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
  // Set once a transition has been triggered, so later ticks keep polling
  // vitals (for a live display) without re-evaluating HR or restarting Chopin.
  const transitionRef = useRef(false);
  const transitionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPolling = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const clearTransitionTimeout = useCallback(() => {
    if (transitionTimeoutRef.current !== null) {
      clearTimeout(transitionTimeoutRef.current);
      transitionTimeoutRef.current = null;
    }
  }, []);

  // Switches to the white-noise playlist once the current Chopin track ends.
  // Runs on its own timer (not inside tick()'s in-flight guard) so polling for
  // live vitals keeps going while this waits out the remaining track.
  const completeTransition = useCallback(async (accessToken: string) => {
    try {
      const deviceId = await findDeviceByName(accessToken, deviceName);
      if (deviceId) {
        await startPlaylist(accessToken, WHITENOISE_PLAYLIST, deviceId);
      }
      clearPolling();
      dispatch({ type: 'DONE' });
    } catch (err) {
      dispatch({ type: 'ERROR', payload: err instanceof Error ? err.message : String(err) });
    }
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

      if (monitorOnly || transitionRef.current) return;

      if (reading.heart_rate !== null && reading.heart_rate < HR_THRESHOLD) {
        transitionRef.current = true;
        dispatch({ type: 'TRANSITIONING' });

        // remaining_seconds comes from a live Spotify query made after
        // owlet.read() + token refresh already finished, so it is already
        // fresh as of now — waiting it out in full lands exactly on the
        // track boundary without cutting into the still-playing Chopin track.
        const remainingSeconds = playback?.remaining_seconds ?? 0;
        transitionTimeoutRef.current = setTimeout(() => {
          transitionTimeoutRef.current = null;
          void completeTransition(accessToken);
        }, Math.max(0, remainingSeconds * 1000));
      } else {
        const remainingSeconds = playback?.remaining_seconds ?? null;
        if (remainingSeconds === null || remainingSeconds < RESTART_THRESHOLD_SECONDS) {
          const deviceId = await findDeviceByName(accessToken, deviceName);
          if (deviceId) {
            await startPlaylist(accessToken, CHOPIN_PLAYLIST, deviceId);
          }
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
    dispatch({ type: 'START' });
    intervalRef.current = setInterval(tick, pollIntervalMs);
  }, [tick, pollIntervalMs]);

  const stop = useCallback(() => {
    clearPolling();
    clearTransitionTimeout();
    transitionRef.current = false;
    dispatch({ type: 'STOP' });
  }, [clearPolling, clearTransitionTimeout]);

  useEffect(() => {
    return () => {
      clearPolling();
      clearTransitionTimeout();
    };
  }, [clearPolling, clearTransitionTimeout]);

  return { state, start, stop };
}
