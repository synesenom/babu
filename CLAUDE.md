# CLAUDE.md

## Project overview

Bedtime automation: Owlet Smart Sock heart rate → Spotify playlist control. When the baby's BPM drops below 110, the app switches from Chopin nocturnes to white noise. There are two independent implementations — Python (CLI) and Node.js (web server) — that share the same conceptual design.

---

## Repository layout

```
main.py          Python CLI — entry point for the polling loop
server.js        Node.js Express server — REST API + SSE + web UI
lib/owlet.py     Python Owlet client
lib/owlet.js     JavaScript Owlet client (same auth chain, native fetch)
lib/spotify.py   Python Spotify controller (spotipy)
lib/spotify.js   JavaScript Spotify controller (spotify-web-api-node)
lib/routine.js   BedtimeRoutine EventEmitter state machine (Node.js only)
public/index.html Mobile-optimized dark-theme UI, driven by SSE
.env.example     Canonical list of required env vars
pyproject.toml   Poetry — Python >=3.12,<3.13
package.json     Node.js dependencies
```

---

## Running the project

**Python:**
```bash
poetry run python main.py
```

**Node.js:**
```bash
npm start          # http://localhost:3000
```

The Node.js path is the primary interface. Use Python only for quick one-off tests or debugging the Owlet connection.

---

## Key constants (change here when tweaking behavior)

| Constant | File | Value | Meaning |
|---|---|---|---|
| `HR_THRESHOLD` | `lib/routine.js`, `main.py` | 110 BPM | Sleep detection threshold |
| `POLL_INTERVAL_MS` | `lib/routine.js` | 10 000 ms | Owlet polling interval |
| `CHOPIN_PLAYLIST` | `lib/routine.js` | `spotify:playlist:5MKaz5wxcypYQLklyx34J2` | Lullaby playlist |
| `WHITENOISE_PLAYLIST` | `lib/routine.js` | `spotify:playlist:4Lj9ZugyG3SNEA9XAxGVwx` | Sleep playlist |

The Python `main.py` hardcodes the same playlist URIs directly.

---

## Architecture notes

### Owlet auth chain
Both `owlet.py` and `owlet.js` implement the same three-step flow:
1. Firebase sign-in (email + password → `idToken` JWT)
2. Owlet SSO mini-token request (uses Android spoofing headers to bypass API key validation)
3. Ayla Networks `token_sign_in` → `access_token` used for all device calls

EU region uses a separate Ayla endpoint. Token refresh is handled automatically before expiry.

Both clients support two firmware variants:
- New: `REAL_TIME_VITALS` property (JSON blob)
- Old: individual properties (`HEART_RATE`, `OXYGEN_LEVEL`, etc.)

### `read()` return shape (both clients)
```
{
  heart_rate: int | None,
  oxygen: int | None,
  battery: int | None,
  movement: "still" | "moving" | None,
  sock_off: bool,
  base_on: bool,
  charging: bool,
  sock_connected: bool,
  dsn: str,
  timestamp: str,   // "YYYY-MM-DD HH:MM:SS"
  raw: dict,        // full Ayla property dump
}
```

### BedtimeRoutine state machine (`lib/routine.js`)
```
idle → running → transitioning → done
```
- Polling starts on `start()`, stops on `stop()` or when state reaches `done`.
- Emits `status`, `reading`, and `error` events consumed by `server.js`.
- Transition waits for current track to finish (polls `getRemainingSeconds()`).

### Server-Sent Events
`server.js` maintains an array of SSE response objects (`sseClients`). All Owlet readings and state changes are broadcast via `broadcast()`. The web UI connects to `/api/events` and updates the DOM in real time. No WebSocket needed.

### Spotify token persistence
- Python (spotipy): caches OAuth token automatically in `.cache` file.
- Node.js: persists token to `.spotify-token.json`. Check for this file if auth breaks.

---

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `OWLET_EMAIL` | Yes | Owlet account email |
| `OWLET_PWD` | Yes | Owlet account password |
| `OWLET_REGION` | No | `europe` or `world` (default: `world`) |
| `SPOTIFY_CLIENT_ID` | Yes | Spotify Developer app client ID |
| `SPOTIFY_CLIENT_SECRET` | Yes | Spotify Developer app client secret |
| `SPOTIFY_DEVICE_NAME` | Yes (Node.js) | Spotify device name to target (e.g. `iphone`) |
| `PORT` | No | HTTP server port (default: 3000) |

---

## Development approach

This project follows strict TDD. For every unit of code:

1. **Write the test first** — define the expected behaviour via a failing test
2. **Run it and confirm it fails** — a test that passes before implementation is not testing anything
3. **Write the minimum implementation to make it pass**
4. **Refactor** — clean up without changing behaviour; tests stay green throughout

Never write implementation code that does not have a corresponding test written first. If you are asked to implement a feature, write the test file first, confirm it fails (`npm test -- <file> --no-coverage`), then implement.

---

## Common tasks

### Change the sleep BPM threshold
Edit `HR_THRESHOLD` in both `lib/routine.js` and `main.py`.

### Change playlists
Edit `CHOPIN_PLAYLIST` / `WHITENOISE_PLAYLIST` in `lib/routine.js` and the equivalent URIs in `main.py`.

### Debug Owlet connection
Run a one-shot read in Python:
```python
from lib.owlet import Owlet
import os, asyncio
owlet = Owlet(os.environ["OWLET_EMAIL"], os.environ["OWLET_PWD"], region="europe")
print(owlet.read())
```

Or hit the Node.js endpoint:
```bash
curl http://localhost:3000/api/owlet/reading
```

### Debug Spotify auth (Node.js)
Delete `.spotify-token.json` and re-authenticate via the UI or `GET /auth/spotify`.

### Sync the Python and JS Owlet clients
`lib/owlet.py` and `lib/owlet.js` are parallel implementations. If you fix a bug in the auth flow, apply it to both files.

---

## Dependencies

**Python** (managed via Poetry):
- `pyowletapi` — Owlet API wrapper (partially used for reference; the custom `Owlet` class in `lib/owlet.py` does its own auth)
- `spotipy` — Spotify Web API client
- `requests` — HTTP

**Node.js**:
- `express` — HTTP server
- `spotify-web-api-node` — Spotify Web API client
- `dotenv` — env var loading

Spotify Premium is required. The Owlet integration uses an unofficial API and may break on Owlet backend updates.
