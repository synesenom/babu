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
  clientSecret: string = '',
): {
  state: RoutineState;
  start: () => void;
  stop: () => void;
} {
  const [state, dispatch] = useReducer(reducer, initialState);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearPolling = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const tick = useCallback(async () => {
    if (!owlet || !tokens) return;

    try {
      const reading = await owlet.read();
      dispatch({ type: 'READING', payload: reading });

      // Spotify access tokens expire after ~1 hour; an overnight monitor runs far
      // longer than that. Refresh before every Spotify call so a stale token never
      // reaches the API (the cause of the daily 403). Falls back to the passed-in
      // token when no client credentials are available (e.g. mock mode).
      let accessToken = tokens.access_token;
      if (clientId) {
        const valid = await getValidToken(clientId, clientSecret);
        if (valid) accessToken = valid;
      }

      const playback = await getCurrentPlayback(accessToken);
      dispatch({ type: 'NOW_PLAYING', payload: playback });

      if (!monitorOnly) {
        if (reading.heart_rate !== null && reading.heart_rate < HR_THRESHOLD) {
          clearPolling();
          dispatch({ type: 'TRANSITIONING' });

          const remainingSeconds = playback?.remaining_seconds ?? 0;
          if (remainingSeconds > 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, remainingSeconds * 1000));
          }

          const deviceId = await findDeviceByName(accessToken, deviceName);
          if (deviceId) {
            await startPlaylist(accessToken, WHITENOISE_PLAYLIST, deviceId);
          }
          dispatch({ type: 'DONE' });
        } else {
          const remainingSeconds = playback?.remaining_seconds ?? null;
          if (remainingSeconds === null || remainingSeconds < RESTART_THRESHOLD_SECONDS) {
            const deviceId = await findDeviceByName(accessToken, deviceName);
            if (deviceId) {
              await startPlaylist(accessToken, CHOPIN_PLAYLIST, deviceId);
            }
          }
        }
      }
    } catch (err) {
      dispatch({ type: 'ERROR', payload: err instanceof Error ? err.message : String(err) });
    }
  }, [owlet, tokens, deviceName, monitorOnly, clearPolling, clientId, clientSecret]);

  const start = useCallback(() => {
    dispatch({ type: 'START' });
    intervalRef.current = setInterval(tick, pollIntervalMs);
  }, [tick]);

  const stop = useCallback(() => {
    clearPolling();
    dispatch({ type: 'STOP' });
  }, [clearPolling]);

  useEffect(() => {
    return () => {
      clearPolling();
    };
  }, [clearPolling]);

  return { state, start, stop };
}
