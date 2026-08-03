import type { SpotifyAccessToken, SpotifyDevice, SpotifyDeviceId, SpotifyPlayback, SpotifyTokens } from './types';
import { MOCK_TOKEN } from './constants';

const SPOTIFY_API = 'https://api.spotify.com/v1';

export class SpotifyError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'SpotifyError';
  }
}

async function spotifyFetch(url: string, token: SpotifyAccessToken, options: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  return res;
}

export async function getDevices(token: SpotifyAccessToken): Promise<SpotifyDevice[]> {
  if (token === MOCK_TOKEN) return [];
  const res = await spotifyFetch(`${SPOTIFY_API}/me/player/devices`, token);
  if (!res.ok) {
    throw new SpotifyError(res.status, `getDevices failed: ${res.status}`);
  }
  const data = await res.json();
  return (data.devices ?? []).map((d: Record<string, unknown>) => ({
    id: d.id as string,
    name: d.name as string,
    type: d.type as string,
    is_active: d.is_active as boolean,
    volume_percent: (d.volume_percent as number) ?? 0,
  }));
}

function toPlayback(playback: Record<string, unknown>): SpotifyPlayback {
  const track = playback.item as Record<string, unknown>;
  const progressMs: number = (playback.progress_ms as number) ?? 0;
  const durationMs: number = (track.duration_ms as number) ?? 0;
  const remainingMs = durationMs - progressMs;

  return {
    is_playing: (playback.is_playing as boolean) ?? false,
    track_name: (track.name as string) ?? 'Unknown',
    artist_name: ((track.artists ?? []) as Array<{ name: string }>).map((a) => a.name).join(', '),
    album_name: (track.album as { name?: string })?.name ?? 'Unknown',
    progress_ms: progressMs,
    duration_ms: durationMs,
    remaining_ms: remainingMs,
    remaining_seconds: remainingMs / 1000,
    device_name: (playback.device as { name?: string })?.name ?? 'Unknown',
    device_id: (playback.device as { id?: string })?.id ?? '',
  };
}

export async function getCurrentPlayback(token: SpotifyAccessToken): Promise<SpotifyPlayback | null> {
  if (token === MOCK_TOKEN) return null;
  const res = await spotifyFetch(`${SPOTIFY_API}/me/player`, token);
  if (res.status === 204) return null;
  if (!res.ok) {
    throw new SpotifyError(res.status, `getCurrentPlayback failed: ${res.status}`);
  }
  const playback = await res.json();
  if (!playback || !playback.item) return null;

  return toPlayback(playback);
}

export async function getRemainingSeconds(token: SpotifyAccessToken): Promise<number | null> {
  const playback = await getCurrentPlayback(token);
  return playback ? playback.remaining_seconds : null;
}

function isOkOrNoContent(res: Response): boolean {
  return res.ok || res.status === 204;
}

export async function startPlaylist(token: SpotifyAccessToken, playlistUri: string, deviceId: SpotifyDeviceId): Promise<boolean> {
  if (token === MOCK_TOKEN) return true;
  const url = `${SPOTIFY_API}/me/player/play?device_id=${encodeURIComponent(deviceId)}`;
  const res = await spotifyFetch(url, token, {
    method: 'PUT',
    body: JSON.stringify({ context_uri: playlistUri }),
  });
  return isOkOrNoContent(res);
}

async function setPlaybackState(action: 'play' | 'pause', token: SpotifyAccessToken, deviceId?: SpotifyDeviceId): Promise<boolean> {
  if (token === MOCK_TOKEN) return true;
  const url = deviceId
    ? `${SPOTIFY_API}/me/player/${action}?device_id=${encodeURIComponent(deviceId)}`
    : `${SPOTIFY_API}/me/player/${action}`;
  const res = await spotifyFetch(url, token, { method: 'PUT' });
  return isOkOrNoContent(res);
}

export function pause(token: SpotifyAccessToken, deviceId?: SpotifyDeviceId): Promise<boolean> {
  return setPlaybackState('pause', token, deviceId);
}

export function play(token: SpotifyAccessToken, deviceId?: SpotifyDeviceId): Promise<boolean> {
  return setPlaybackState('play', token, deviceId);
}

export async function findDeviceByName(token: SpotifyAccessToken, nameSubstring: string): Promise<string | null> {
  if (token === MOCK_TOKEN) return 'mock-device-id';
  const devices = await getDevices(token);
  const match = devices.find((d) =>
    d.name.toLowerCase().includes(nameSubstring.toLowerCase())
  );
  return match ? match.id : null;
}

export async function refreshAccessToken(
  clientId: string,
  refreshToken: string,
): Promise<SpotifyTokens> {
  // PKCE / public-client refresh: the client_id goes in the body and there is no
  // client secret. The app ships its bundle to phones, so a secret could not be
  // kept private anyway — see Spotify's "refreshing tokens" PKCE guidance.
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new SpotifyError(res.status, `refreshAccessToken failed: ${res.status}`);
  }

  const data = await res.json();
  return {
    access_token: data.access_token as string,
    refresh_token: (data.refresh_token as string | undefined) ?? refreshToken,
    expires_at: Date.now() + (data.expires_in as number) * 1000,
  };
}
