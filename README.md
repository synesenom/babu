# babu

![Coverage](https://img.shields.io/badge/coverage-68%25-yellow)

Automated bedtime routine for Android: monitors a baby's heart rate via the **Owlet Smart Sock** and controls **Spotify** playback accordingly. Playback starts with Chopin nocturnes; once the heart rate drops below the sleep threshold, the app waits for the current track to finish and switches to white noise.

Built with React Native ([Expo](https://expo.dev)) and TypeScript.

---

## How it works

1. Enter your Owlet credentials in the app, connect Spotify via OAuth, and enter the name of the Spotify device to control.
2. Tap **Start Routine** — the app begins playing the **Chopin playlist** on the target device.
3. Every **5 seconds** the app polls the Owlet Smart Sock for the baby's vitals and Spotify for the current playback state.
4. While the routine is running, if playback has stopped or a track is about to end (fewer than 5 seconds remaining), the app restarts the Chopin playlist so the music never goes silent.
5. When the heart rate falls **below 120 BPM**, the app waits for the current track to finish, then starts the **white noise playlist**.
6. The routine is done — the app shows a completion screen and the white noise keeps playing.

A **Monitor only** switch on the setup screen disables all playback control: the app just displays live vitals and the currently playing track.

---

## Prerequisites

- **Owlet Smart Sock** (v2 or v3) paired to your Owlet account
- **Spotify Premium** account (free accounts cannot control playback via the API)
- A **Spotify Developer app** (see setup below)
- Android device or emulator (Android Studio)

---

## Setup

### 1. Create a Spotify Developer app

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) and log in.
2. Click **Create app** and fill in any name.
3. Under **Redirect URIs** add: `babu://auth` (and `exp://localhost:8081/--/` for emulator/dev builds).
4. Under **APIs used** check **Web API**, then save.
5. Copy the **Client ID** and **Client Secret**.
6. Go to **Users and Access** and add your Spotify account email (required while the app is in Development mode).

### 2. Install dependencies

```bash
cd app
npm install
```

### 3. Configure credentials

Create `app/.env` (see `app/.env.example`):

```env
SPOTIFY_CLIENT_ID=your_spotify_client_id
```

The client ID is baked into the build by `app/app.config.js`. There is no client secret — the app uses Spotify's PKCE public-client flow, so nothing sensitive is bundled into the distributed APK. Owlet credentials are **not** configured here — they are entered in the app at runtime and stored on-device with `expo-secure-store`.

---

## Running on an Android emulator

### 1. Create a virtual device

Open Android Studio → **Tools → Device Manager** → **+** → Create Virtual Device. Pick a phone (e.g. Pixel 8) and a system image (API 35 recommended).

### 2. Start the emulator

Launch the device from Device Manager, or from the terminal:

```bash
~/Library/Android/sdk/emulator/emulator -avd <your_avd_name>
```

### 3. Add Android tools to your PATH

Add to `~/.zshrc`:

```sh
export ANDROID_HOME=$HOME/Library/Android/sdk
export PATH=$PATH:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools
```

Then: `source ~/.zshrc`

### 4. Build and install

```bash
cd app
npx expo run:android
```

This generates the native `android/` project (gitignored), builds, installs on the running emulator, and starts the Metro dev server.

---

## Running on a physical Android device

### 1. Enable Developer options

Settings → About phone → tap **Build number** 7 times until you see "You are now a developer".

> **Samsung:** Settings → About phone → Software information → Build number.
> If the tap is blocked by **Auto Blocker**, disable it first: Settings → Security and privacy → Auto Blocker → off.

### 2a. Option A — USB

Enable **USB debugging** in Developer options, connect the phone, then build and install a release APK:

```bash
cd app/android
ANDROID_HOME=$HOME/Library/Android/sdk ./gradlew assembleRelease
adb install -r app/build/outputs/apk/release/app-release.apk
```

(If `app/android/` does not exist yet, generate it first with `cd app && npx expo prebuild --platform android`.)

### 2b. Option B — Wireless (no cable)

Both phone and computer must be on the same Wi-Fi network.

1. Developer options → **Wireless debugging** → enable it
2. Tap **Pair device with pairing code** — note the IP, port, and 6-digit code
3. On your computer:
   ```bash
   adb pair <ip>:<pairing-port>
   # enter the 6-digit code when prompted
   ```
4. Connect (use the port shown on the main Wireless debugging screen, not the pairing port):
   ```bash
   adb connect <ip>:<connect-port>
   adb devices   # phone should appear
   ```
5. Build and install as in Option A.

---

## Using the app

### Setup screen

- **Owlet email / password** — your Owlet account credentials. Saved on-device after the first successful start.
- **Region** — `world` (North America) or `europe` (EU Ayla endpoint).
- **Connect Spotify** — opens the Spotify OAuth flow in a browser (PKCE). Tokens are stored securely on-device.
- **Device** — a substring of the Spotify device name to control (case-insensitive). The app calls the Spotify API, lists your active devices, and picks the first one whose name contains what you typed. For example, typing `iPhone` will match `Enys's iPhone`. To see the device names available: open Spotify on the target phone or speaker → tap the **device icon** (cast icon) at the bottom of the Now Playing bar — every listed device name is a valid value. If no active device matches when a routine tick fires, playback is skipped silently until a match appears.
- **Monitor only** — show vitals without touching playback.

### Monitoring screen

Live heart rate, oxygen level, battery, sock status, and the currently playing track. **Stop** aborts the routine and returns to setup.

### Done screen

Shown once the white noise playlist has started. Returning resets the navigation stack back to setup.

---

## Configuration reference

All tunables live in `app/src/lib/constants.ts`:

| Constant | Default | Description |
|---|---|---|
| `HR_THRESHOLD` | 120 | BPM below which sleep is detected |
| `POLL_INTERVAL_MS` | 5 000 | Owlet/Spotify polling interval (ms) |
| `RESTART_THRESHOLD_SECONDS` | 5 | If less than this remains in the current track (or nothing is playing), the Chopin playlist is (re)started |
| `CHOPIN_PLAYLIST` | `spotify:playlist:5MKaz5wxcypYQLklyx34J2` | Lullaby playlist URI |
| `WHITENOISE_PLAYLIST` | `spotify:playlist:4Lj9ZugyG3SNEA9XAxGVwx` | Sleep playlist URI |

---

## Architecture

### Project structure

```
app/
├── src/
│   ├── screens/
│   │   ├── SetupScreen.tsx       # Credential form + Spotify OAuth
│   │   ├── MonitoringScreen.tsx  # Live vitals + routine controls
│   │   └── DoneScreen.tsx        # Completion screen
│   ├── hooks/
│   │   └── useRoutine.ts         # Polling loop + state machine
│   ├── lib/
│   │   ├── owlet.ts              # Owlet client (Firebase → SSO → Ayla)
│   │   ├── spotifyApi.ts         # Spotify Web API (direct fetch)
│   │   ├── spotifyAuth.ts        # OAuth PKCE + SecureStore persistence
│   │   ├── types.ts              # Shared TypeScript types
│   │   └── constants.ts          # Thresholds, playlists, Owlet endpoints
│   └── navigation/
│       └── types.ts              # React Navigation stack param types
├── e2e/                          # Maestro E2E flows
├── app.config.js                 # Expo config (injects .env values)
└── app.json                      # App metadata (name, package, scheme)
```

### Routine state machine

```
idle → running → transitioning → done
```

Managed by the `useRoutine` hook (`app/src/hooks/useRoutine.ts`) with `useReducer`. On each tick it reads the Owlet vitals and the Spotify playback state; when the heart rate drops below `HR_THRESHOLD`, polling stops, the hook waits out the remaining seconds of the current track, then starts the white noise playlist and transitions to `done`.

### Owlet auth chain

`app/src/lib/owlet.ts` implements the unofficial three-step Owlet flow:

1. Firebase sign-in (email + password → `idToken` JWT)
2. Owlet SSO mini-token request (Android spoofing headers bypass API key validation)
3. Ayla Networks `token_sign_in` → `access_token` used for all device calls

The EU region uses separate Firebase/Ayla endpoints. Tokens are refreshed automatically before expiry. Both Smart Sock firmware variants are supported: the newer `REAL_TIME_VITALS` JSON property and the older individual properties (`HEART_RATE`, `OXYGEN_LEVEL`, …).

### Spotify

`spotifyAuth.ts` runs the OAuth authorization-code flow with PKCE via `expo-auth-session` and persists tokens in `expo-secure-store`. `spotifyApi.ts` calls the Web API directly with `fetch` — no SDK dependency.

---

## Development

```bash
cd app
npm test                # Jest unit tests
npm run test:coverage   # with coverage report
```

The project follows TDD: write the failing test first, then the implementation.

**Mock mode** — set `MOCK_MODE=1` in `app/.env` to stub out all Spotify calls (useful for UI work without a Premium account or a real device):

```bash
MOCK_MODE=1 npx expo start
```

**E2E tests** — [Maestro](https://maestro.mobile.dev) flows live in `app/e2e/`:

```bash
cd app
maestro test e2e/
```

**CI** — GitHub Actions runs the Jest suite with coverage on every push/PR and updates the coverage badge in this README on pushes to `main`.

---

## Notes

- Spotify Premium is required — free accounts cannot control playback via the API.
- The Owlet integration uses an unofficial reverse-engineered API and may break if Owlet updates their backend.
- The heart-rate threshold (120 BPM) is tuned for an infant; adjust `HR_THRESHOLD` to taste.
- **Credential storage:** Owlet credentials (email and password) are persisted in `expo-secure-store` with `WHEN_UNLOCKED_THIS_DEVICE_ONLY` protection. On a non-rooted device this is reasonably safe, but a rooted or otherwise compromised device could expose the raw password. The Owlet unofficial API does not provide a refresh-token mechanism, so storing the password is currently unavoidable. Do not use this app on a rooted device, and avoid reusing your Owlet password on other services.
