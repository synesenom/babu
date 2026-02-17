require('dotenv').config();

const express = require('express');
const path = require('path');
const { Owlet } = require('./lib/owlet');
const { SpotifyController } = require('./lib/spotify');
const { BedtimeRoutine } = require('./lib/routine');

const PORT = process.env.PORT || 3000;
const BASE = process.env.BASE_PATH || '/projects/baby-sleep';

const app = express();
const router = express.Router();

router.use(express.json());
router.use(express.static(path.join(__dirname, 'public')));

// --- Globals ---

let owlet = null;
let routine = null;
let sseClients = [];
let lastReading = null;
let routineState = 'idle';

const spotify = new SpotifyController(
  process.env.SPOTIFY_CLIENT_ID,
  process.env.SPOTIFY_CLIENT_SECRET,
  process.env.SPOTIFY_REDIRECT_URI || `http://127.0.0.1:${PORT}${BASE}/auth/spotify/callback`
);

// --- SSE ---

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach((res) => res.write(msg));
}

router.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('\n');
  sseClients.push(res);
  req.on('close', () => {
    sseClients = sseClients.filter((c) => c !== res);
  });
});

// --- Spotify OAuth ---

router.get('/auth/spotify', (req, res) => {
  res.redirect(spotify.getAuthorizeUrl());
});

router.get('/auth/spotify/callback', async (req, res) => {
  try {
    await spotify.handleCallback(req.query.code);
    res.redirect(BASE + '/');
  } catch (err) {
    res.status(500).send(`Spotify auth failed: ${err.message}`);
  }
});

// --- API ---

router.get('/api/status', (req, res) => {
  res.json({
    routine_state: routineState,
    spotify_authenticated: spotify.isAuthenticated(),
    owlet_connected: owlet !== null,
    last_reading: lastReading,
  });
});

router.post('/api/routine/start', async (req, res) => {
  if (routine && routine.state === 'running') {
    return res.json({ ok: false, message: 'Routine already running' });
  }

  if (!spotify.isAuthenticated()) {
    return res.json({ ok: false, message: 'Spotify not authenticated. Connect Spotify first.' });
  }

  try {
    if (!owlet) {
      owlet = await Owlet.create(
        process.env.OWLET_EMAIL,
        process.env.OWLET_PWD,
        process.env.OWLET_REGION || 'world'
      );
    }

    const deviceName = process.env.SPOTIFY_DEVICE_NAME || 'iphone';
    routine = new BedtimeRoutine(owlet, spotify, deviceName);

    routine.on('status', (data) => {
      routineState = data.state;
      broadcast('status', data);
    });

    routine.on('reading', (data) => {
      lastReading = data;
      broadcast('reading', data);
    });

    routine.on('error', (data) => {
      broadcast('error', data);
    });

    await routine.start();
    res.json({ ok: true, message: 'Routine started' });
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
});

router.post('/api/routine/stop', (req, res) => {
  if (routine) {
    routine.stop();
    routine = null;
  }
  routineState = 'idle';
  res.json({ ok: true, message: 'Routine stopped' });
});

router.get('/api/owlet/reading', async (req, res) => {
  try {
    if (!owlet) {
      owlet = await Owlet.create(
        process.env.OWLET_EMAIL,
        process.env.OWLET_PWD,
        process.env.OWLET_REGION || 'world'
      );
    }
    const data = await owlet.read();
    lastReading = data;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/spotify/devices', async (req, res) => {
  try {
    const devices = await spotify.getDevices();
    res.json(devices);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/spotify/playback', async (req, res) => {
  try {
    const playback = await spotify.getCurrentPlayback();
    res.json(playback);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mount router at base path
app.use(BASE, router);

// --- Start server ---

app.listen(PORT, '127.0.0.1', () => {
  console.log(`\nBabu server running on port ${PORT}`);
  console.log(`  URL: http://127.0.0.1:${PORT}${BASE}`);
  console.log(`  Spotify: ${spotify.isAuthenticated() ? 'Authenticated' : 'Not authenticated'}\n`);
});
