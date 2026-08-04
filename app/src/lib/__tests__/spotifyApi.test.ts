import fetchMock from 'jest-fetch-mock';
import {
  SpotifyError,
  getDevices,
  getCurrentPlayback,
  getRemainingSeconds,
  startPlaylist,
  pause,
  play,
  findDeviceByName,
  refreshAccessToken,
  resetMockPlayback,
} from '../spotifyApi';
import { MOCK_TOKEN, CHOPIN_PLAYLIST, WHITENOISE_PLAYLIST } from '../constants';

const TOKEN = 'test-access-token';

beforeEach(() => {
  fetchMock.resetMocks();
});

// ---------------------------------------------------------------------------
// getDevices()
// ---------------------------------------------------------------------------

describe('getDevices()', () => {
  it('parses device array into SpotifyDevice[]', async () => {
    fetchMock.mockResponseOnce(
      JSON.stringify({
        devices: [
          { id: 'dev1', name: "Enys's iPhone", type: 'Smartphone', is_active: true, volume_percent: 80 },
          { id: 'dev2', name: 'MacBook Pro', type: 'Computer', is_active: false, volume_percent: 50 },
        ],
      }),
      { status: 200 },
    );

    const devices = await getDevices(TOKEN);

    expect(devices).toHaveLength(2);
    expect(devices[0]).toEqual({
      id: 'dev1',
      name: "Enys's iPhone",
      type: 'Smartphone',
      is_active: true,
      volume_percent: 80,
    });
    expect(devices[1].id).toBe('dev2');
  });

  it('throws SpotifyError(401) on 401 response', async () => {
    fetchMock.mockResponse('Unauthorized', { status: 401 });

    const err = await getDevices(TOKEN).catch((e) => e);
    expect(err).toBeInstanceOf(SpotifyError);
    expect(err.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// getCurrentPlayback()
// ---------------------------------------------------------------------------

describe('getCurrentPlayback()', () => {
  it('returns null on HTTP 204 (nothing playing)', async () => {
    fetchMock.mockResponseOnce('', { status: 204 });

    const result = await getCurrentPlayback(TOKEN);

    expect(result).toBeNull();
  });

  it('parses track/artist/album/timing fields correctly', async () => {
    fetchMock.mockResponseOnce(
      JSON.stringify({
        is_playing: true,
        progress_ms: 60000,
        item: {
          name: 'Nocturne Op. 9 No. 2',
          duration_ms: 270000,
          artists: [{ name: 'Chopin' }, { name: 'Piano' }],
          album: { name: 'Nocturnes' },
        },
        device: { name: 'iPhone', id: 'dev1' },
      }),
      { status: 200 },
    );

    const playback = await getCurrentPlayback(TOKEN);

    expect(playback).not.toBeNull();
    expect(playback!.track_name).toBe('Nocturne Op. 9 No. 2');
    expect(playback!.artist_name).toBe('Chopin, Piano');
    expect(playback!.album_name).toBe('Nocturnes');
    expect(playback!.progress_ms).toBe(60000);
    expect(playback!.duration_ms).toBe(270000);
    expect(playback!.remaining_ms).toBe(210000);
    expect(playback!.remaining_seconds).toBe(210);
    expect(playback!.device_name).toBe('iPhone');
    expect(playback!.device_id).toBe('dev1');
    expect(playback!.is_playing).toBe(true);
  });

  it('returns null when response body has no item', async () => {
    fetchMock.mockResponseOnce(
      JSON.stringify({ is_playing: false, progress_ms: 0, device: { name: 'iPhone', id: 'dev1' } }),
      { status: 200 },
    );

    const result = await getCurrentPlayback(TOKEN);

    expect(result).toBeNull();
  });

  it('throws SpotifyError on non-204 error response', async () => {
    fetchMock.mockResponse('Forbidden', { status: 403 });

    const err = await getCurrentPlayback(TOKEN).catch((e) => e);
    expect(err).toBeInstanceOf(SpotifyError);
    expect(err.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// getRemainingSeconds()
// ---------------------------------------------------------------------------

describe('getRemainingSeconds()', () => {
  it('returns null when nothing is playing (204)', async () => {
    fetchMock.mockResponseOnce('', { status: 204 });

    const result = await getRemainingSeconds(TOKEN);

    expect(result).toBeNull();
  });

  it('returns the correct remaining seconds when a track is playing', async () => {
    fetchMock.mockResponseOnce(
      JSON.stringify({
        is_playing: true,
        progress_ms: 30000,
        item: {
          name: 'Test Track',
          duration_ms: 180000,
          artists: [{ name: 'Artist' }],
          album: { name: 'Album' },
        },
        device: { name: 'iPhone', id: 'dev1' },
      }),
      { status: 200 },
    );

    const result = await getRemainingSeconds(TOKEN);

    expect(result).toBe(150);
  });
});

// ---------------------------------------------------------------------------
// startPlaylist()
// ---------------------------------------------------------------------------

describe('startPlaylist()', () => {
  it('sends PUT with correct context_uri body and device_id query param', async () => {
    fetchMock.mockResponseOnce('', { status: 204 });

    const playlistUri = 'spotify:playlist:5MKaz5wxcypYQLklyx34J2';
    const deviceId = 'dev1';
    const result = await startPlaylist(TOKEN, playlistUri, deviceId);

    expect(result).toBe(true);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain(`device_id=${encodeURIComponent(deviceId)}`);
    expect(options?.method).toBe('PUT');
    expect(JSON.parse(options?.body as string)).toEqual({ context_uri: playlistUri });
  });
});

// ---------------------------------------------------------------------------
// pause()
// ---------------------------------------------------------------------------

describe('pause()', () => {
  it('sends PUT to pause endpoint without device_id when omitted', async () => {
    fetchMock.mockResponseOnce('', { status: 204 });

    const result = await pause(TOKEN);

    expect(result).toBe(true);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.spotify.com/v1/me/player/pause');
    expect(options?.method).toBe('PUT');
  });

  it('includes device_id query param when provided', async () => {
    fetchMock.mockResponseOnce('', { status: 204 });

    await pause(TOKEN, 'dev1');

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('device_id=dev1');
  });
});

// ---------------------------------------------------------------------------
// play()
// ---------------------------------------------------------------------------

describe('play()', () => {
  it('sends PUT to play endpoint without device_id when omitted', async () => {
    fetchMock.mockResponseOnce('', { status: 204 });

    const result = await play(TOKEN);

    expect(result).toBe(true);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.spotify.com/v1/me/player/play');
    expect(options?.method).toBe('PUT');
  });

  it('includes device_id query param when provided', async () => {
    fetchMock.mockResponseOnce('', { status: 204 });

    await play(TOKEN, 'dev1');

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('device_id=dev1');
  });
});

// ---------------------------------------------------------------------------
// findDeviceByName()
// ---------------------------------------------------------------------------

describe('findDeviceByName()', () => {
  it('matches "iPhone" when device list contains "Enys\'s iPhone"', async () => {
    fetchMock.mockResponseOnce(
      JSON.stringify({
        devices: [
          { id: 'dev1', name: "Enys's iPhone", type: 'Smartphone', is_active: true, volume_percent: 80 },
        ],
      }),
      { status: 200 },
    );

    const id = await findDeviceByName(TOKEN, 'iPhone');

    expect(id).toBe('dev1');
  });

  it('returns null when no device name matches', async () => {
    fetchMock.mockResponseOnce(
      JSON.stringify({
        devices: [
          { id: 'dev1', name: 'MacBook Pro', type: 'Computer', is_active: false, volume_percent: 50 },
        ],
      }),
      { status: 200 },
    );

    const id = await findDeviceByName(TOKEN, 'iPhone');

    expect(id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// refreshAccessToken()
// ---------------------------------------------------------------------------

describe('refreshAccessToken()', () => {
  it('POSTs grant_type=refresh_token form body and returns parsed SpotifyTokens', async () => {
    const expiresIn = 3600;
    const before = Date.now();
    fetchMock.mockResponseOnce(
      JSON.stringify({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: expiresIn,
      }),
      { status: 200 },
    );

    const tokens = await refreshAccessToken('client-id', 'old-refresh-token');

    expect(tokens.access_token).toBe('new-access-token');
    expect(tokens.refresh_token).toBe('new-refresh-token');
    expect(tokens.expires_at).toBeGreaterThanOrEqual(before + expiresIn * 1000);

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://accounts.spotify.com/api/token');
    expect(options?.method).toBe('POST');
    expect(options?.body).toContain('grant_type=refresh_token');
    expect(options?.body).toContain('refresh_token=old-refresh-token');
    // PKCE public-client refresh: client_id goes in the body, no client secret.
    expect(options?.body).toContain('client_id=client-id');
    expect((options?.headers as Record<string, string>)?.Authorization).toBeUndefined();
  });

  it('throws SpotifyError on 400 (invalid refresh token)', async () => {
    fetchMock.mockResponse('Bad Request', { status: 400 });

    const err = await refreshAccessToken('client-id', 'bad-refresh-token').catch((e) => e);
    expect(err).toBeInstanceOf(SpotifyError);
    expect(err.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Fields the transition needs in order to be verifiable rather than hopeful:
// which track is playing (identity, not display name) and which playlist it
// came from.
// ---------------------------------------------------------------------------

describe('getCurrentPlayback() — transition-critical fields', () => {
  function playbackBody(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      is_playing: true,
      progress_ms: 60000,
      context: { uri: 'spotify:playlist:5MKaz5wxcypYQLklyx34J2' },
      item: {
        id: '4Oun2ylbjFKMPTiaSbbCih',
        name: 'Nocturne Op. 9 No. 2',
        duration_ms: 270000,
        artists: [{ name: 'Chopin' }],
        album: { name: 'Nocturnes' },
      },
      device: { name: 'iPhone', id: 'dev1' },
      ...overrides,
    });
  }

  it('exposes the track id, so a repeat of the same track is not mistaken for the same play', async () => {
    fetchMock.mockResponseOnce(playbackBody(), { status: 200 });

    const playback = await getCurrentPlayback(TOKEN);

    expect(playback!.track_id).toBe('4Oun2ylbjFKMPTiaSbbCih');
  });

  it('exposes the playing context uri, so the white-noise switch can be verified', async () => {
    fetchMock.mockResponseOnce(playbackBody(), { status: 200 });

    const playback = await getCurrentPlayback(TOKEN);

    expect(playback!.context_uri).toBe('spotify:playlist:5MKaz5wxcypYQLklyx34J2');
  });

  it('reports a null context uri when playback has no context (single track, radio)', async () => {
    fetchMock.mockResponseOnce(playbackBody({ context: null }), { status: 200 });

    const playback = await getCurrentPlayback(TOKEN);

    expect(playback!.context_uri).toBeNull();
  });

  it('falls back to an empty track id rather than throwing when Spotify omits it', async () => {
    fetchMock.mockResponseOnce(
      playbackBody({
        item: { name: 'Local file', duration_ms: 1000, artists: [], album: { name: '' } },
      }),
      { status: 200 },
    );

    const playback = await getCurrentPlayback(TOKEN);

    expect(playback!.track_id).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 202 Accepted means Spotify took the request but the target device was not
// ready — it wakes the device and the play may or may not follow. Reporting it
// as success is how a switch gets reported "done" with nothing audible.
// ---------------------------------------------------------------------------

describe('startPlaylist() — what counts as started', () => {
  it('reports started on 204 No Content', async () => {
    fetchMock.mockResponseOnce('', { status: 204 });
    await expect(startPlaylist(TOKEN, 'spotify:playlist:wn', 'dev1')).resolves.toBe(true);
  });

  it('reports started on 200 OK', async () => {
    fetchMock.mockResponseOnce('', { status: 200 });
    await expect(startPlaylist(TOKEN, 'spotify:playlist:wn', 'dev1')).resolves.toBe(true);
  });

  it('does NOT report started on 202 Accepted (device asleep, nothing playing yet)', async () => {
    fetchMock.mockResponseOnce('', { status: 202 });
    await expect(startPlaylist(TOKEN, 'spotify:playlist:wn', 'dev1')).resolves.toBe(false);
  });

  it('does not report started on 404 (device gone)', async () => {
    fetchMock.mockResponseOnce('', { status: 404 });
    await expect(startPlaylist(TOKEN, 'spotify:playlist:wn', 'dev1')).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mock mode has to model playback, not just return nothing. A hardcoded null
// playback means the routine can never see a track to wait out and can never
// confirm white noise started, so the whole transition is unexercisable — which
// is how the mock build came to show a transition that never happened.
// ---------------------------------------------------------------------------

describe('mock mode', () => {
  beforeEach(() => {
    resetMockPlayback();
  });

  it('reports Chopin playing to begin with', async () => {
    const playback = await getCurrentPlayback(MOCK_TOKEN);

    expect(playback).not.toBeNull();
    expect(playback!.is_playing).toBe(true);
    expect(playback!.context_uri).toBe(CHOPIN_PLAYLIST);
  });

  it('reports a track that actually finishes, so a transition can complete', async () => {
    const playback = await getCurrentPlayback(MOCK_TOKEN);

    expect(playback!.remaining_ms).toBeGreaterThan(0);
    expect(playback!.remaining_ms).toBeLessThanOrEqual(30_000);
  });

  it('reports white noise once the white-noise playlist has been started', async () => {
    await startPlaylist(MOCK_TOKEN, WHITENOISE_PLAYLIST, 'mock-device-id');

    const playback = await getCurrentPlayback(MOCK_TOKEN);

    expect(playback!.context_uri).toBe(WHITENOISE_PLAYLIST);
  });

  it('makes no network calls', async () => {
    await getCurrentPlayback(MOCK_TOKEN);
    await startPlaylist(MOCK_TOKEN, WHITENOISE_PLAYLIST, 'mock-device-id');

    expect(fetchMock.mock.calls).toHaveLength(0);
  });
});
