import type { SpotifyDevice, SpotifyPlayback, SpotifyTokens } from './types';

const SPOTIFY_API = 'https://api.spotify.com/v1';

export class SpotifyError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'SpotifyError';
  }
}

async function spotifyFetch(url: string, token: string, options: RequestInit = {}): Promise<Response> {
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

export async function getDevices(token: string): Promise<SpotifyDevice[]> {
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

export async function getCurrentPlayback(token: string): Promise<SpotifyPlayback | null> {
  const res = await spotifyFetch(`${SPOTIFY_API}/me/player`, token);
  if (res.status === 204) return null;
  if (!res.ok) {
    throw new SpotifyError(res.status, `getCurrentPlayback failed: ${res.status}`);
  }
  const playback = await res.json();
  if (!playback || !playback.item) return null;

  const track = playback.item;
  const progressMs: number = playback.progress_ms ?? 0;
  const durationMs: number = track.duration_ms ?? 0;
  const remainingMs = durationMs - progressMs;

  return {
    is_playing: playback.is_playing ?? false,
    track_name: track.name ?? 'Unknown',
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

export async function getRemainingSeconds(token: string): Promise<number | null> {
  const playback = await getCurrentPlayback(token);
  return playback ? playback.remaining_seconds : null;
}

export async function startPlaylist(token: string, playlistUri: string, deviceId: string): Promise<boolean> {
  const url = `${SPOTIFY_API}/me/player/play?device_id=${encodeURIComponent(deviceId)}`;
  const res = await spotifyFetch(url, token, {
    method: 'PUT',
    body: JSON.stringify({ context_uri: playlistUri }),
  });
  return res.ok || res.status === 204;
}

export async function pause(token: string, deviceId?: string): Promise<boolean> {
  const url = deviceId
    ? `${SPOTIFY_API}/me/player/pause?device_id=${encodeURIComponent(deviceId)}`
    : `${SPOTIFY_API}/me/player/pause`;
  const res = await spotifyFetch(url, token, { method: 'PUT' });
  return res.ok || res.status === 204;
}

export async function play(token: string, deviceId?: string): Promise<boolean> {
  const url = deviceId
    ? `${SPOTIFY_API}/me/player/play?device_id=${encodeURIComponent(deviceId)}`
    : `${SPOTIFY_API}/me/player/play`;
  const res = await spotifyFetch(url, token, { method: 'PUT' });
  return res.ok || res.status === 204;
}

export async function findDeviceByName(token: string, nameSubstring: string): Promise<string | null> {
  const devices = await getDevices(token);
  const match = devices.find((d) =>
    d.name.toLowerCase().includes(nameSubstring.toLowerCase())
  );
  return match ? match.id : null;
}

export async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<SpotifyTokens> {
  const credentials = btoa(`${clientId}:${clientSecret}`);
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
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
