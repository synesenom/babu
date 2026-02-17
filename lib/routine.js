/**
 * Bedtime Routine - State machine port of main.py.
 *
 * Monitors baby's heart rate via Owlet, plays Chopin,
 * and switches to white noise when heart rate drops below threshold.
 */

const { EventEmitter } = require('events');

const CHOPIN_PLAYLIST = 'spotify:playlist:5MKaz5wxcypYQLklyx34J2';
const WHITENOISE_PLAYLIST = 'spotify:playlist:4Lj9ZugyG3SNEA9XAxGVwx';
const HR_THRESHOLD = 110;
const POLL_INTERVAL_MS = 10000;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

class BedtimeRoutine extends EventEmitter {
  constructor(owlet, spotify, deviceName = 'iphone') {
    super();
    this.owlet = owlet;
    this.spotify = spotify;
    this.deviceName = deviceName;
    this.state = 'idle'; // idle | running | transitioning | done
    this._timer = null;
  }

  async start() {
    this.state = 'running';
    this.emit('status', { state: 'running', message: 'Starting bedtime routine' });
    this._poll();
  }

  stop() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this.state = 'idle';
    this.emit('status', { state: 'idle', message: 'Routine stopped' });
  }

  async _poll() {
    if (this.state !== 'running') return;

    try {
      const data = await this.owlet.read();
      this.emit('reading', data);

      if (data.heart_rate < HR_THRESHOLD) {
        await this._switchToWhiteNoise();
      } else {
        await this._keepPlayingChopin();
        if (this.state === 'running') {
          this._timer = setTimeout(() => this._poll(), POLL_INTERVAL_MS);
        }
      }
    } catch (err) {
      this.emit('error', { message: err.message });
      if (this.state === 'running') {
        this._timer = setTimeout(() => this._poll(), POLL_INTERVAL_MS);
      }
    }
  }

  async _switchToWhiteNoise() {
    this.state = 'transitioning';
    this.emit('status', { state: 'transitioning', message: 'Switching to white noise' });

    const remaining = await this.spotify.getRemainingSeconds();
    if (remaining !== null) {
      await delay(remaining * 1000);
    }

    await this.spotify.startPlaylist(WHITENOISE_PLAYLIST, this.deviceName);
    this.state = 'done';
    this.emit('status', { state: 'done', message: 'White noise playing. Routine complete.' });
  }

  async _keepPlayingChopin() {
    const remaining = await this.spotify.getRemainingSeconds();

    if (remaining === null) {
      await this.spotify.startPlaylist(CHOPIN_PLAYLIST, this.deviceName);
      return;
    }

    if (remaining < 10.0) {
      await delay(remaining * 1000);
      await this.spotify.startPlaylist(CHOPIN_PLAYLIST, this.deviceName);
    }
  }
}

module.exports = { BedtimeRoutine };
