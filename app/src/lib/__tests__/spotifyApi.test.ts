import fetchMock from 'jest-fetch-mock';
import {
  SpotifyError,
  getDevices,
  getCurrentPlayback,
  getRemainingSeconds,
  startPlaylist,
  findDeviceByName,
  refreshAccessToken,
} from '../spotifyApi';

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

    const tokens = await refreshAccessToken('client-id', 'client-secret', 'old-refresh-token');

    expect(tokens.access_token).toBe('new-access-token');
    expect(tokens.refresh_token).toBe('new-refresh-token');
    expect(tokens.expires_at).toBeGreaterThanOrEqual(before + expiresIn * 1000);

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://accounts.spotify.com/api/token');
    expect(options?.method).toBe('POST');
    expect(options?.body).toContain('grant_type=refresh_token');
    expect(options?.body).toContain('refresh_token=old-refresh-token');
  });

  it('throws SpotifyError on 400 (invalid refresh token)', async () => {
    fetchMock.mockResponse('Bad Request', { status: 400 });

    const err = await refreshAccessToken('client-id', 'client-secret', 'bad-refresh-token').catch((e) => e);
    expect(err).toBeInstanceOf(SpotifyError);
    expect(err.status).toBe(400);
  });
});
