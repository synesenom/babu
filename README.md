# baby-sleep

![Coverage](https://img.shields.io/badge/coverage-72%25-yellow)

Automated bedtime routine that monitors a baby's heart rate via the **Owlet Smart Sock** and controls **Spotify** playback accordingly. Starts with Chopin nocturnes and switches to white noise once the heart rate drops below the sleep threshold.

---

## How it works

1. Spotify starts playing the **Chopin playlist** on your phone/device.
2. Every 10 seconds the app polls the Owlet Smart Sock for the baby's current heart rate.
3. When heart rate falls **below 110 BPM** (configurable), the app waits for the current track to finish and then transitions to the **white noise playlist**.
4. The routine ends after the white noise starts playing.

The Owlet auth chain goes: Firebase (email/password → idToken) → Owlet SSO mini-token → Ayla Networks access token → device property fetch. Both implementations handle the full chain automatically, including token refresh.

---

## Playlists

| Role | Spotify URI |
|---|---|
| Lullaby (Chopin) | `spotify:playlist:5MKaz5wxcypYQLklyx34J2` |
| White noise | `spotify:playlist:4Lj9ZugyG3SNEA9XAxGVwx` |

Change these in `lib/routine.js` (Node.js) or `main.py` (Python).

---

## Architecture

There are two independent implementations that share the same idea:

### Python (CLI)
`main.py` → `lib/owlet.py` + `lib/spotify.py`

Simple polling loop. Good for quick tests from the terminal. Uses [spotipy](https://spotipy.readthedocs.io/) for Spotify and a hand-rolled Ayla/Owlet client.

### Node.js (web UI)
`server.js` → `lib/owlet.js` + `lib/spotify.js` + `lib/routine.js`

Express server with a mobile-friendly dark-theme UI at `/`. Uses Server-Sent Events (SSE) for live heart-rate and status updates. The `BedtimeRoutine` class is an `EventEmitter`-based state machine.

```
States: idle → running → transitioning → done
```

The web UI is the primary interface — it lets you start/stop the routine from your phone while the sock is on.

---

## Prerequisites

- **Owlet Smart Sock** (v2 or v3) paired to your Owlet account
- **Spotify Premium** account (required for playback control and crossfade)
- A **Spotify Developer app** with `http://localhost:8888/callback` in the redirect URIs
- Python ≥ 3.12 (CLI path) **or** Node.js (web path)

---

## Setup

### 1. Clone and install

**Python:**
```bash
pip install poetry
poetry install
```

**Node.js:**
```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

```env
OWLET_EMAIL=your_owlet_email@example.com
OWLET_PWD=your_owlet_password
OWLET_REGION=europe          # "europe" or "world" (US)

SPOTIFY_CLIENT_ID=your_spotify_app_client_id
SPOTIFY_CLIENT_SECRET=your_spotify_app_client_secret
SPOTIFY_DEVICE_NAME=iphone   # Spotify device name to target

PORT=3000
```

> **Spotify app setup:** Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard), create an app, and add `http://localhost:8888/callback` (Python) or `http://localhost:3000/auth/spotify/callback` (Node.js) as a redirect URI.

---

## Running

### Python CLI

```bash
poetry run python main.py
```

On first run, Spotipy opens a browser for Spotify OAuth and caches the token locally. The script polls every 10 seconds and prints live heart rate to the console.

### Node.js web server

```bash
npm start
# Open http://localhost:3000 on your phone
```

1. Visit the UI and tap **Authenticate Spotify** (first time only — token is saved to `.spotify-token.json`).
2. Tap **Start Routine** — the app starts the Chopin playlist on the configured device and begins monitoring.
3. Watch the live vitals card update every 10 seconds.
4. The app automatically transitions to white noise when the baby falls asleep.

---

## API reference (Node.js server)

| Method | Path | Description |
|---|---|---|
| GET | `/api/status` | Routine state + last Owlet reading |
| POST | `/api/routine/start` | Start the bedtime routine |
| POST | `/api/routine/stop` | Stop the routine |
| GET | `/api/owlet/reading` | One-shot Owlet reading |
| GET | `/api/spotify/devices` | List available Spotify devices |
| GET | `/api/spotify/playback` | Current track + progress |
| GET | `/auth/spotify` | Redirect to Spotify OAuth |
| GET | `/auth/spotify/callback` | Spotify OAuth callback |
| GET | `/api/events` | SSE stream (status, reading, error) |

---

## Configuration reference

| Variable | Where | Default | Description |
|---|---|---|---|
| `HR_THRESHOLD` | `lib/routine.js`, `main.py` | 110 | BPM below which sleep is detected |
| `POLL_INTERVAL_MS` | `lib/routine.js` | 10 000 | Owlet polling interval (ms) |
| Crossfade | `lib/spotify.py` | 6 s | Transition duration between tracks |
| Restart threshold | `lib/spotify.py`, `lib/routine.js` | 10 s | Re-start Chopin if < 10 s remain |

---

## Project structure

```
baby-sleep/
├── main.py              # Python CLI entry point
├── server.js            # Node.js Express server
├── lib/
│   ├── owlet.py         # Python Owlet client (Firebase → SSO → Ayla)
│   ├── owlet.js         # JavaScript Owlet client (same auth chain)
│   ├── spotify.py       # Python Spotify controller (spotipy)
│   ├── spotify.js       # JavaScript Spotify controller
│   └── routine.js       # BedtimeRoutine EventEmitter state machine
├── public/
│   └── index.html       # Mobile UI (dark theme, SSE-driven)
├── .env.example         # Environment variable template
├── pyproject.toml       # Python/Poetry config
└── package.json         # Node.js config
```

---

## Notes

- Spotify Premium is required — free accounts cannot control playback via the API.
- The Owlet integration uses an unofficial reverse-engineered API. It may break if Owlet updates their backend.
- The Python and Node.js Owlet clients are independent ports of the same auth logic; keep them in sync if you patch the auth flow.
- `OWLET_REGION=europe` points to the EU Ayla endpoint; use `world` for North America.
