# baby-sleep

![Coverage](https://img.shields.io/badge/coverage-72%25-yellow)

Automated bedtime routine that monitors a baby's heart rate via the **Owlet Smart Sock** and controls **Spotify** playback accordingly. Starts with Chopin nocturnes and switches to white noise once the heart rate drops below the sleep threshold.

---

## How it works

1. Enter your Owlet and Spotify credentials in the app and tap **Connect Spotify**.
2. Tap **Start Routine** — Spotify starts playing the **Chopin playlist** on your target device.
3. Every 10 seconds the app polls the Owlet Smart Sock for the baby's heart rate.
4. When heart rate falls **below 110 BPM**, the app waits for the current track to finish and transitions to the **white noise playlist**.
5. The routine ends and the app returns to the setup screen.

---

## Playlists

| Role | Spotify URI |
|---|---|
| Lullaby (Chopin) | `spotify:playlist:5MKaz5wxcypYQLklyx34J2` |
| White noise | `spotify:playlist:4Lj9ZugyG3SNEA9XAxGVwx` |

Change these in `app/src/lib/constants.ts`.

---

## Architecture

The app is a **React Native** app built with [Expo](https://expo.dev), targeting Android.

### Screens

```
SetupScreen → MonitoringScreen → DoneScreen
```

- **SetupScreen** — enter Owlet credentials, connect Spotify via OAuth (PKCE), pick a Spotify device name, then start the routine.
- **MonitoringScreen** — shows live heart rate, O₂, battery, and currently playing track. Handles the lullaby → white noise transition automatically.
- **DoneScreen** — confirmation screen shown when the baby is asleep and white noise is playing.

### State machine

```
idle → running → transitioning → done
```

Managed by the `useRoutine` hook (`app/src/hooks/useRoutine.ts`). Polls Owlet every 10 seconds and drives Spotify via the Web API.

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
│   │   ├── spotifyAuth.ts        # OAuth PKCE + SecureStore
│   │   ├── types.ts              # Shared TypeScript types
│   │   └── constants.ts          # HR threshold, poll interval, playlist URIs
│   └── navigation/
│       └── types.ts              # React Navigation stack param types
├── e2e/                          # Maestro E2E flows
├── app.config.js                 # Expo config (reads .env)
└── app.json                      # App metadata (name, package, scheme)
```

---

## Prerequisites

- **Owlet Smart Sock** (v2 or v3) paired to your Owlet account
- **Spotify Premium** account (required for playback control)
- A **Spotify Developer app** (see setup below)
- Android device or emulator (Android Studio)

---

## Spotify app setup

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) and log in.
2. Click **Create app** and fill in any name.
3. Under **Redirect URIs** add: `babu://auth` (and `exp://localhost:8081/--/` for emulator/dev builds)
4. Under **APIs used** check **Web API**, then save.
5. Copy the **Client ID** and **Client Secret**.
6. Go to **Users and Access** and add your Spotify account email (required while the app is in Development mode).

---

## Setup

### 1. Install dependencies

```bash
cd app
npm install
```

### 2. Configure credentials

Create `app/.env`:

```env
SPOTIFY_CLIENT_ID=your_spotify_client_id
SPOTIFY_CLIENT_SECRET=your_spotify_client_secret
```

Owlet credentials are entered in the app at runtime and saved securely on-device.

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
cd app/android
ANDROID_HOME=$HOME/Library/Android/sdk ./gradlew assembleRelease
adb install -r app/build/outputs/apk/release/app-release.apk
```

---

## Running on a physical Android device

### 1. Enable Developer options

Settings → About phone → tap **Build number** 7 times until you see "You are now a developer".

> **Samsung:** Settings → About phone → Software information → Build number.
> If the tap is blocked by **Auto Blocker**, disable it first: Settings → Security and privacy → Auto Blocker → off.

### 2. Option A — USB

Enable **USB debugging** in Developer options, connect the phone, then build and install:

```bash
cd app/android
ANDROID_HOME=$HOME/Library/Android/sdk ./gradlew assembleRelease
adb install -r app/build/outputs/apk/release/app-release.apk
```

### 2. Option B — Wireless (no cable)

Both phone and Mac must be on the same Wi-Fi network.

1. Developer options → **Wireless debugging** → enable it
2. Tap **Pair device with pairing code** — note the IP, port, and 6-digit code
3. On your Mac:
   ```bash
   adb pair <ip>:<pairing-port>
   # enter the 6-digit code when prompted
   ```
4. Connect (use the port shown on the main Wireless debugging screen, not the pairing port):
   ```bash
   adb connect <ip>:<connect-port>
   adb devices   # phone should appear
   ```
5. Build and install:
   ```bash
   cd app/android
   ANDROID_HOME=$HOME/Library/Android/sdk ./gradlew assembleRelease
   adb install -r app/build/outputs/apk/release/app-release.apk
   ```

---

## Finding your Spotify device name

Open Spotify on your phone → tap the **device icon** (bottom of the player screen). Your device will be listed by name — enter that exact name in the app's Device field on the setup screen.

---

## Configuration reference

| Constant | File | Default | Description |
|---|---|---|---|
| `HR_THRESHOLD` | `src/lib/constants.ts` | 110 | BPM below which sleep is detected |
| `POLL_INTERVAL_MS` | `src/lib/constants.ts` | 10 000 | Owlet polling interval (ms) |
| `CHOPIN_PLAYLIST` | `src/lib/constants.ts` | — | Lullaby playlist URI |
| `WHITENOISE_PLAYLIST` | `src/lib/constants.ts` | — | Sleep playlist URI |

---

## Notes

- Spotify Premium is required — free accounts cannot control playback via the API.
- The Owlet integration uses an unofficial reverse-engineered API. It may break if Owlet updates their backend.
- `OWLET_REGION=europe` (entered in the app) points to the EU Ayla endpoint; leave blank for North America.
