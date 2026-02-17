/**
 * Spotify Controller - Node.js port.
 *
 * Uses spotify-web-api-node for Spotify Web API access.
 * OAuth flow is handled via Express routes in server.js.
 */

const SpotifyWebApi = require('spotify-web-api-node');
const fs = require('fs');
const path = require('path');

const TOKEN_FILE = path.join(__dirname, '..', '.spotify-token.json');
const SCOPES = ['user-modify-playback-state', 'user-read-playback-state'];

class SpotifyController {
  constructor(clientId, clientSecret, redirectUri = 'http://127.0.0.1:3000/auth/spotify/callback') {
    this.api = new SpotifyWebApi({
      clientId,
      clientSecret,
      redirectUri,
    });
    this._expiresAt = 0;
    this._loadTokens();
  }

  // --- Auth ---

  getAuthorizeUrl() {
    return this.api.createAuthorizeURL(SCOPES, 'babu-state');
  }

  async handleCallback(code) {
    const data = await this.api.authorizationCodeGrant(code);
    this.api.setAccessToken(data.body.access_token);
    this.api.setRefreshToken(data.body.refresh_token);
    this._expiresAt = Date.now() + data.body.expires_in * 1000;
    this._saveTokens();
  }

  isAuthenticated() {
    return Boolean(this.api.getAccessToken());
  }

  async _ensureFreshToken() {
    if (!this.api.getRefreshToken()) return;
    if (Date.now() < this._expiresAt - 60000) return; // still valid
    const data = await this.api.refreshAccessToken();
    this.api.setAccessToken(data.body.access_token);
    this._expiresAt = Date.now() + data.body.expires_in * 1000;
    this._saveTokens();
  }

  _saveTokens() {
    try {
      fs.writeFileSync(
        TOKEN_FILE,
        JSON.stringify({
          access_token: this.api.getAccessToken(),
          refresh_token: this.api.getRefreshToken(),
          expires_at: this._expiresAt,
        })
      );
    } catch {
      // ignore write errors
    }
  }

  _loadTokens() {
    try {
      if (fs.existsSync(TOKEN_FILE)) {
        const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
        this.api.setAccessToken(data.access_token);
        this.api.setRefreshToken(data.refresh_token);
        this._expiresAt = data.expires_at || 0;
      }
    } catch {
      // ignore read errors
    }
  }

  // --- Devices ---

  async getDevices() {
    await this._ensureFreshToken();
    const data = await this.api.getMyDevices();
    return data.body.devices;
  }

  async findDeviceByName(nameSubstring) {
    const devices = await this.getDevices();
    const match = devices.find((d) =>
      d.name.toLowerCase().includes(nameSubstring.toLowerCase())
    );
    return match ? match.id : null;
  }

  async getActiveDevice() {
    const devices = await this.getDevices();
    const active = devices.find((d) => d.is_active);
    return active ? active.id : null;
  }

  // --- Playback ---

  async getCurrentPlayback() {
    await this._ensureFreshToken();
    const data = await this.api.getMyCurrentPlaybackState();
    const playback = data.body;

    if (!playback || !playback.item) return null;

    const track = playback.item;
    const progressMs = playback.progress_ms || 0;
    const durationMs = track.duration_ms || 0;
    const remainingMs = durationMs - progressMs;

    return {
      is_playing: playback.is_playing || false,
      track_name: track.name || 'Unknown',
      artist_name: (track.artists || []).map((a) => a.name).join(', '),
      album_name: (track.album || {}).name || 'Unknown',
      progress_ms: progressMs,
      duration_ms: durationMs,
      remaining_ms: remainingMs,
      remaining_seconds: remainingMs / 1000,
      progress_seconds: progressMs / 1000,
      duration_seconds: durationMs / 1000,
      device_name: (playback.device || {}).name || 'Unknown',
      device_type: (playback.device || {}).type || 'Unknown',
      shuffle_state: playback.shuffle_state || false,
      repeat_state: playback.repeat_state || 'off',
    };
  }

  async getRemainingSeconds() {
    const playback = await this.getCurrentPlayback();
    return playback ? playback.remaining_seconds : null;
  }

  async startPlaylist(playlistUri, deviceName = null, deviceId = null) {
    await this._ensureFreshToken();
    let targetDevice = deviceId;

    if (!targetDevice && deviceName) {
      targetDevice = await this.findDeviceByName(deviceName);
      if (!targetDevice) {
        console.log(`Device '${deviceName}' not found.`);
        return false;
      }
    }
    if (!targetDevice) {
      targetDevice = await this.getActiveDevice();
      if (!targetDevice) {
        console.log('No active device found.');
        return false;
      }
    }

    await this.api.play({ device_id: targetDevice, context_uri: playlistUri });
    console.log('Playlist started successfully');
    return true;
  }

  async pause(deviceName = null, deviceId = null) {
    await this._ensureFreshToken();
    const targetDevice =
      deviceId || (deviceName ? await this.findDeviceByName(deviceName) : null);
    await this.api.pause({ device_id: targetDevice });
    return true;
  }

  async play(deviceName = null, deviceId = null) {
    await this._ensureFreshToken();
    const targetDevice =
      deviceId || (deviceName ? await this.findDeviceByName(deviceName) : null);
    await this.api.play({ device_id: targetDevice });
    return true;
  }
}

module.exports = { SpotifyController };
