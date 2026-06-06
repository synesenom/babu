# React Native migration plan

Convert the Node.js web server into a standalone Android app with Expo + TypeScript.
The Python code and `server.js` / `public/` are not part of this migration and can be removed when ready.

The new app lives in `app/` within this repo. The existing `lib/` files remain as reference during migration.

---

## Development device

Use the **Android Emulator** (via Android Studio) throughout. It gives full fidelity — custom URL schemes work, so Spotify OAuth completes without any stubs or workarounds. The setup is one-time.

**One-time setup:**
1. Download and install [Android Studio](https://developer.android.com/studio)
2. Open Android Studio → More Actions → Virtual Device Manager → Create Device
3. Pick any Pixel device, select a recent API level (API 34 recommended), finish the wizard
4. Start the emulator (▶ button in Virtual Device Manager)

**Daily workflow:**
```bash
cd app
npx expo run:android   # builds and installs on the running emulator; hot-reloads on save
```

The first `expo run:android` takes a few minutes to compile. Subsequent runs are fast.

---

## Technology choices

| Concern | Choice | Reason |
|---|---|---|
| Framework | Expo managed workflow | Zero native build setup; Android APK via `eas build` |
| Language | TypeScript | Type safety across the Owlet/Spotify boundary |
| Navigation | `@react-navigation/native-stack` | Standard, well-tested |
| Spotify OAuth | `expo-auth-session` (PKCE) | Works in Android Emulator and on device; no stub needed |
| Token storage | `expo-secure-store` | Encrypted on-device; replaces `.spotify-token.json` |
| Unit tests | Jest + `@testing-library/react-native` | Ships with Expo |
| E2E tests | Maestro | YAML-based, works with Expo Go on Android |

**Why direct Spotify `fetch` calls instead of `spotify-web-api-node`:** that package imports Node.js `http`, which does not exist in React Native's Hermes runtime. We call the Spotify Web API directly with `fetch` instead.

**Why no EventEmitter in the hook:** React Native ships the Node.js `events` package, but the idiomatic RN pattern is `useReducer` + `useRef` for interval-driven state machines. This is what `useRoutine` uses.

---

## Screens

```
SetupScreen  →  MonitoringScreen  →  DoneScreen
               (auto-advance)
```

- **SetupScreen** — enter Owlet credentials, connect Spotify OAuth, pick device, tap Start
- **MonitoringScreen** — live vitals + now-playing card, Stop button; auto-advances on sleep detection
- **DoneScreen** — confirmation, "Start again" resets to Setup

---

## Step 1 — Scaffold Expo project

**Goal:** Bootstrap the `app/` directory with Expo + TypeScript, install all dependencies at once, configure Jest and folder structure.

**Commands:**
```bash
# From baby-sleep/
npx create-expo-app@latest app --template expo-template-blank-typescript
cd app

# Expo-managed packages (peer dep resolution handled by expo install)
npx expo install expo-auth-session expo-secure-store expo-web-browser
npx expo install react-native-screens react-native-safe-area-context

# Navigation
npm install @react-navigation/native @react-navigation/native-stack

# Test utilities
npm install --save-dev @testing-library/react-native @testing-library/jest-native jest-fetch-mock

# Folder structure
mkdir -p src/lib/__mocks__ src/lib/__tests__ src/hooks/__tests__ src/screens src/navigation
```

**`app.json` — add deep-link scheme (required for Spotify OAuth redirect):**
```json
{
  "expo": {
    "name": "Babu",
    "slug": "babu",
    "scheme": "babu",
    "android": { "package": "com.enysmones.babu" }
  }
}
```

**`jest.config.js` — add fetch mock setup:**
```js
module.exports = {
  preset: 'jest-expo',
  setupFilesAfterFramework: [
    '@testing-library/jest-native/extend-expect',
    './jest.setup.ts',
  ],
};
```

**`jest.setup.ts`:**
```ts
import fetchMock from 'jest-fetch-mock';
fetchMock.enableMocks();
```

**Verify:** `npm test` passes (0 tests, no errors); run `npx expo run:android` with the emulator open and confirm the blank app installs and renders.

---

## Step 2 — Shared types and constants

**Goal:** Define all TypeScript interfaces and app-wide constants in one place so every subsequent step imports from here.

**Files:**
- `src/lib/types.ts` (~65 lines)
- `src/lib/constants.ts` (~40 lines)

**`src/lib/types.ts`:**
```ts
export type OwletRegion = 'world' | 'europe';

export interface OwletReading {
  heart_rate: number | null;
  oxygen: number | null;
  battery: number | null;
  movement: 'moving' | 'still' | null;
  sock_off: boolean;
  sock_connected: boolean;
  base_on: boolean;
  charging: boolean;
  dsn: string;
  timestamp: string;
  raw: Record<string, unknown>;
}

export interface SpotifyDevice {
  id: string;
  name: string;
  type: string;
  is_active: boolean;
  volume_percent: number;
}

export interface SpotifyPlayback {
  is_playing: boolean;
  track_name: string;
  artist_name: string;
  album_name: string;
  progress_ms: number;
  duration_ms: number;
  remaining_ms: number;
  remaining_seconds: number;
  device_name: string;
  device_id: string;
}

export interface SpotifyTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Date.now() ms
}

export type RoutineStatus = 'idle' | 'running' | 'transitioning' | 'done';

export interface RoutineState {
  status: RoutineStatus;
  lastReading: OwletReading | null;
  nowPlaying: SpotifyPlayback | null;
  error: string | null;
}
```

**`src/lib/constants.ts`:**
```ts
export const HR_THRESHOLD = 110;
export const POLL_INTERVAL_MS = 10_000;
export const RESTART_THRESHOLD_SECONDS = 10;

export const CHOPIN_PLAYLIST = 'spotify:playlist:5MKaz5wxcypYQLklyx34J2';
export const WHITENOISE_PLAYLIST = 'spotify:playlist:4Lj9ZugyG3SNEA9XAxGVwx';

export const SPOTIFY_SCOPES = ['user-modify-playback-state', 'user-read-playback-state'];

export const OWLET_REGIONS = {
  world: {
    firebase_api_key: 'AIzaSyCsDZ8kWxQuLJAMVnmEhEkayH1TSxKXfGA',
    url_mini: 'https://ayla-sso.owletdata.com/mini/',
    url_signin: 'https://user-field-1a2039d9.aylanetworks.com/api/v1/token_sign_in',
    url_base: 'https://ads-field-1a2039d9.aylanetworks.com/apiv1',
    app_id: 'sso-prod-3g-id',
    app_secret: 'sso-prod-UEjtnPCtFfjdwIwxqnC0OipxRFU',
  },
  europe: {
    firebase_api_key: 'AIzaSyDm6EhV70wudwN3iOSq3vTjtsdGjdFLuuM',
    url_mini: 'https://ayla-sso.eu.owletdata.com/mini/',
    url_signin: 'https://user-field-eu-1a2039d9.aylanetworks.com/api/v1/token_sign_in',
    url_base: 'https://ads-field-eu-1a2039d9.aylanetworks.com/apiv1',
    app_id: 'OwletCare-Android-EU-fw-id',
    app_secret: 'OwletCare-Android-EU-JKupMPBoj_Npce_9a95Pc8Qo0Mw',
  },
} as const;

export const ANDROID_SPOOF_HEADERS = {
  'X-Android-Package': 'com.owletcare.owletcare',
  'X-Android-Cert': '2A3BC26DB0B8B0792DBE28E6FFDC2598F9B12B74',
};
```

**Verify:** `tsc --noEmit` passes with no errors.

---

## Step 3 — Owlet client (TypeScript)

**Goal:** Port `lib/owlet.js` to TypeScript. The auth chain is identical; the only change is replacing `AbortSignal.timeout()` (not available on Hermes) with a manual `AbortController`.

**File:** `src/lib/owlet.ts` (~185 lines)

Port `lib/owlet.js` with these changes:
1. Import types from `./types` and constants from `./constants`
2. Replace `AbortSignal.timeout(ms)` with:
   ```ts
   function makeSignal(ms: number): AbortSignal {
     const ctrl = new AbortController();
     setTimeout(() => ctrl.abort(), ms);
     return ctrl.signal;
   }
   ```
3. Replace `module.exports` with named `export`
4. All private helpers (`firebaseSignIn`, `getMiniToken`, `aylaSignIn`, `authenticate`, `getDsns`, `activate`, `getProps`, `parse`) stay as module-level functions — not class methods — so they can be unit-tested individually if needed
5. Public surface:
   ```ts
   export class OwletError extends Error {}
   export class Owlet {
     static async create(email: string, password: string, region?: OwletRegion, dsn?: string): Promise<Owlet>;
     async read(): Promise<OwletReading>;
   }
   ```

No logic changes from the JS version.

---

## Step 4 — Owlet unit tests

**Goal:** Full coverage of the Owlet auth chain and property parsing using mocked `fetch`.

**Files:**
- `src/lib/__mocks__/fixtures.ts` (~60 lines) — shared fixture data
- `src/lib/__tests__/owlet.test.ts` (~180 lines)

**`fixtures.ts`** defines reusable mock responses:
```ts
export const FIREBASE_OK = { idToken: 'fake-id-token' };
export const MINI_TOKEN_OK = { mini_token: 'fake-mini-token' };
export const AYLA_SIGNIN_OK = { access_token: 'fake-ayla-token', expires_in: '86400' };
export const DEVICES_OK = [{ device: { dsn: 'AC000W123456789' } }];
export const ACTIVATE_OK = { datapoint: {} };

// New firmware: REAL_TIME_VITALS JSON blob
export const PROPS_RTV_OK = [{
  property: {
    name: 'REAL_TIME_VITALS',
    value: JSON.stringify({ hr: 125, ox: 98, bat: 82, mv: 0, sc: 1, bso: 1, chg: 0 }),
  }
}];

// Old firmware: individual properties
export const PROPS_LEGACY_OK = [
  { property: { name: 'HEART_RATE', value: 118 } },
  { property: { name: 'OXYGEN_LEVEL', value: 97 } },
  { property: { name: 'BATT_LEVEL', value: 75 } },
  { property: { name: 'MOVEMENT', value: 1 } },
  { property: { name: 'SOCK_OFF', value: 0 } },
  { property: { name: 'SOCK_CONNECTION', value: 1 } },
  { property: { name: 'BASE_STATION_ON', value: 1 } },
  { property: { name: 'CHARGE_STATUS', value: 0 } },
];
```

**Test cases in `owlet.test.ts`:**
1. `Owlet.create()` — makes exactly 3 fetch calls (Firebase, SSO, Ayla) with correct URLs
2. `Owlet.create()` — throws `OwletError` when Firebase returns 400
3. `Owlet.create()` — throws `OwletError` when SSO returns missing `mini_token`
4. `Owlet.create()` — throws `OwletError` when no devices found
5. `Owlet.create()` — throws when region is unknown
6. `read()` — calls `activate` then `getProps`, returns parsed `OwletReading`
7. `read()` — parses REAL_TIME_VITALS firmware: correct HR, O2, movement (`'still'`), sock flags
8. `read()` — falls back to legacy individual properties when no REAL_TIME_VITALS
9. `read()` — re-authenticates (3 extra fetches) when token is expired (mock `Date.now()`)

**Verify:** `npm test -- owlet` — all 9 tests green.

---

## Step 5 — Spotify API client (direct fetch)

**Goal:** Replace `spotify-web-api-node` with direct Spotify Web API calls over `fetch`. All functions are pure and stateless — they accept `accessToken` as the first argument so they are easy to test and compose.

**File:** `src/lib/spotifyApi.ts` (~175 lines)

```ts
const SPOTIFY_API = 'https://api.spotify.com/v1';

export class SpotifyError extends Error {
  constructor(public status: number, message: string) { ... }
}

// GET /me/player/devices
export async function getDevices(token: string): Promise<SpotifyDevice[]>

// GET /me/player
// Returns null on 204 (nothing playing) or missing item
export async function getCurrentPlayback(token: string): Promise<SpotifyPlayback | null>

// Convenience: returns null when nothing playing
export async function getRemainingSeconds(token: string): Promise<number | null>

// PUT /me/player/play  (device_id in query param, context_uri in body)
export async function startPlaylist(token: string, playlistUri: string, deviceId: string): Promise<boolean>

// PUT /me/player/pause
export async function pause(token: string, deviceId?: string): Promise<boolean>

// PUT /me/player/play (no body — resume)
export async function play(token: string, deviceId?: string): Promise<boolean>

// Case-insensitive substring match; returns device id or null
export async function findDeviceByName(token: string, nameSubstring: string): Promise<string | null>

// POST https://accounts.spotify.com/api/token  (grant_type=refresh_token)
export async function refreshAccessToken(
  clientId: string, clientSecret: string, refreshToken: string
): Promise<SpotifyTokens>
```

Treat HTTP 204 as success for pause/play/startPlaylist — Spotify returns 204 on accepted commands.

---

## Step 6 — Spotify OAuth + token store

**Goal:** Implement the OAuth 2.0 PKCE flow using `expo-auth-session` and persist tokens encrypted with `expo-secure-store`. This step has no business logic — it is purely auth plumbing.

**File:** `src/lib/spotifyAuth.ts` (~155 lines)

```ts
import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import { refreshAccessToken } from './spotifyApi';

const SECURE_KEY = 'babu_spotify_tokens';

const DISCOVERY: AuthSession.DiscoveryDocument = {
  authorizationEndpoint: 'https://accounts.spotify.com/authorize',
  tokenEndpoint: 'https://accounts.spotify.com/api/token',
};

// React hook — call inside a component (SetupScreen)
// Returns { tokens, promptAsync, isLoading }
export function useSpotifyAuth(clientId: string, clientSecret: string): {
  tokens: SpotifyTokens | null;
  promptAsync: () => Promise<void>;
  isLoading: boolean;
}

// Non-hook helpers (usable anywhere)
export async function loadStoredTokens(): Promise<SpotifyTokens | null>
export async function saveTokens(tokens: SpotifyTokens): Promise<void>
export async function clearTokens(): Promise<void>

// Returns a valid access token, refreshing if needed. Returns null if not authenticated.
export async function getValidToken(clientId: string, clientSecret: string): Promise<string | null>
```

**`useSpotifyAuth` internals:**
1. Call `AuthSession.useAuthRequest(...)` with PKCE, `SPOTIFY_SCOPES`, redirect URI `AuthSession.makeRedirectUri({ scheme: 'babu' })`
2. On response `type === 'success'`: exchange code for tokens via POST to `DISCOVERY.tokenEndpoint`
3. Save tokens with `saveTokens()` and update local state

**Spotify Developer dashboard setup note** (document in comments):
- Add `babu://` and `exp://localhost:8081/--/` as redirect URIs in the app settings.

---

## Step 7 — Spotify unit tests

**Goal:** Verify each Spotify API function handles success and error responses correctly.

**File:** `src/lib/__tests__/spotifyApi.test.ts` (~165 lines)

Mock fetch via `jest-fetch-mock`. Test cases:

1. `getDevices()` — parses device array, maps to `SpotifyDevice[]`
2. `getDevices()` — throws `SpotifyError(401, ...)` on 401
3. `getCurrentPlayback()` — returns `null` on HTTP 204
4. `getCurrentPlayback()` — parses track/artist/album/timing fields correctly
5. `getCurrentPlayback()` — returns `null` when response body has no `item`
6. `getRemainingSeconds()` — returns `null` when nothing playing
7. `getRemainingSeconds()` — returns correct number when track info present
8. `startPlaylist()` — sends PUT with correct `context_uri` body and `device_id` query param
9. `findDeviceByName()` — matches "iPhone" when device list contains "Enys's iPhone"
10. `findDeviceByName()` — returns `null` when no device name matches
11. `refreshAccessToken()` — POSTs `grant_type=refresh_token` form body, returns parsed `SpotifyTokens`
12. `refreshAccessToken()` — throws on 400 (invalid refresh token)

**Verify:** `npm test -- spotifyApi` — all 12 tests green.

---

## Step 8 — `useRoutine` hook

**Goal:** Port `lib/routine.js` to a React hook. Replace the `EventEmitter` state machine with `useReducer`. Use `useRef` to hold the polling interval so it survives re-renders without re-triggering effects.

**File:** `src/hooks/useRoutine.ts` (~160 lines)

```ts
type Action =
  | { type: 'START' }
  | { type: 'STOP' }
  | { type: 'READING'; payload: OwletReading }
  | { type: 'NOW_PLAYING'; payload: SpotifyPlayback | null }
  | { type: 'TRANSITIONING' }
  | { type: 'DONE' }
  | { type: 'ERROR'; payload: string };

function reducer(state: RoutineState, action: Action): RoutineState { ... }

export function useRoutine(
  owlet: Owlet | null,
  tokens: SpotifyTokens | null,
  deviceName: string,
): {
  state: RoutineState;
  start: () => void;
  stop: () => void;
}
```

**Internal logic (mirrors `routine.js`):**
- `start()` dispatches START, starts a polling loop via `setInterval` stored in `useRef`
- Each tick: `owlet.read()` → dispatch READING → fetch playback → dispatch NOW_PLAYING
  - If `heart_rate !== null && heart_rate < HR_THRESHOLD`: dispatch TRANSITIONING, wait for remaining track time (`getRemainingSeconds`), call `startPlaylist(WHITENOISE_PLAYLIST, deviceId)`, dispatch DONE, clear interval
  - Else: if remaining < `RESTART_THRESHOLD_SECONDS` or nothing playing, call `startPlaylist(CHOPIN_PLAYLIST, deviceId)`
- `stop()` clears interval, dispatches STOP
- `useEffect` cleanup clears interval on unmount

`null` heart_rate (sock disconnected) is treated as above threshold — do not transition.

---

## Step 9 — `useRoutine` unit tests

**Goal:** Test every state transition of the routine hook, including sleep detection and early stop, using fake timers so tests run instantly.

**File:** `src/hooks/__tests__/useRoutine.test.ts` (~185 lines)

Setup:
```ts
jest.useFakeTimers();
jest.mock('../../lib/owlet');
jest.mock('../../lib/spotifyApi');
```

Create a helper `makeOwlet(readings: Partial<OwletReading>[])` that returns a mock `Owlet` whose `read()` returns the fixture readings in sequence.

Test cases:
1. Initial state is `{ status: 'idle', lastReading: null, nowPlaying: null, error: null }`
2. `start()` transitions to `{ status: 'running' }`
3. After one tick with HR = 120: status stays `'running'`, `lastReading.heart_rate === 120`
4. After one tick with HR = 90: status becomes `'transitioning'`; after `getRemainingSeconds()` resolves and timer advances, status becomes `'done'`
5. `stop()` while running: status returns to `'idle'`, interval is cleared (no more fetch calls)
6. Owlet `read()` throws: status stays `'running'`, `state.error` is set
7. Owlet returns `heart_rate: null` (sock off): status stays `'running'` (no false transition)
8. `nowPlaying` is updated on each tick from `getCurrentPlayback()`

Use `act(() => jest.advanceTimersByTime(POLL_INTERVAL_MS))` to advance polling.

**Verify:** `npm test -- useRoutine` — all 8 tests green.

---

## Step 10 — App navigation and screen stubs

**Goal:** Wire up React Navigation with typed route parameters and create minimal screen stubs that compile and render.

**Files:**
- `src/navigation/types.ts` (~20 lines)
- `src/screens/SetupScreen.tsx` (~25 lines, stub)
- `src/screens/MonitoringScreen.tsx` (~25 lines, stub)
- `src/screens/DoneScreen.tsx` (~20 lines, stub)
- `App.tsx` (~55 lines, updated)

**`src/navigation/types.ts`:**
```ts
import type { Owlet } from '../lib/owlet';
import type { SpotifyTokens } from '../lib/types';

export type RootStackParamList = {
  Setup: undefined;
  Monitoring: { owlet: Owlet; tokens: SpotifyTokens; deviceName: string };
  Done: undefined;
};
```

**`App.tsx`:**
```ts
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  return (
    <NavigationContainer>
      <Stack.Navigator initialRouteName="Setup" screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Setup" component={SetupScreen} />
        <Stack.Screen name="Monitoring" component={MonitoringScreen} />
        <Stack.Screen name="Done" component={DoneScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
```

**Verify:** `npx expo run:android` → SetupScreen stub renders in the emulator; no TypeScript errors.

---

## Step 11 — SetupScreen

**Goal:** Implement the credential entry form, Spotify OAuth flow, and "Start Routine" entry point.

**File:** `src/screens/SetupScreen.tsx` (~180 lines)

**UI elements (top to bottom):**
1. App title "babu"
2. Section: **Owlet** — `TextInput` for email, `TextInput` (secureTextEntry) for password, `Picker` for region (world / europe)
3. Section: **Spotify** — "Connect Spotify" button; green "Connected" badge once authenticated
4. `TextInput` for Spotify device name (default `'iphone'`)
5. "Start Routine" button — disabled until Spotify connected; shows ActivityIndicator while Owlet initialises

**Behaviour:**
- On mount: `loadStoredTokens()` to restore Spotify auth; load saved Owlet email from `SecureStore.getItemAsync('owlet_email')`
- "Connect Spotify" calls `promptAsync()` from `useSpotifyAuth` — opens the Spotify login page in a browser, redirects back via `babu://` scheme (works in the emulator)
- "Start Routine":
  1. Save Owlet email to SecureStore
  2. `Owlet.create(email, password, region)` — show spinner
  3. On success: `navigation.navigate('Monitoring', { owlet, tokens, deviceName })`
  4. On failure: show inline error message

**Styling:** dark background `#0d1117`, white text, red accent `#f85149`, single-column layout, `SafeAreaView`.

---

## Step 12 — MonitoringScreen

**Goal:** Display live vitals and now-playing info using `useRoutine`, with automatic navigation to DoneScreen on sleep detection.

**File:** `src/screens/MonitoringScreen.tsx` (~180 lines)

**Props (from navigation):** `owlet: Owlet`, `tokens: SpotifyTokens`, `deviceName: string`

**Hook:** `const { state, stop } = useRoutine(owlet, tokens, deviceName)`

**`useEffect`** — auto-navigate when done:
```ts
useEffect(() => {
  if (state.status === 'done') {
    navigation.replace('Done');
  }
}, [state.status]);
```

**Calls `start()` on mount** (inside `useEffect` with `[]`).

**UI sections:**
1. **Status badge** — pill with colour: `running` → blue, `transitioning` → orange, `done` → green
2. **Vitals card** — HR in large red text (shows `--` when null), O2% in blue, battery% in green, movement text; sock-off warning banner when `sock_off === true`
3. **Now Playing card** — track name (bold) + artist; hidden when `nowPlaying === null`
4. **Error banner** — shows `state.error` in red; tap to dismiss
5. **Stop button** — calls `stop()` then `navigation.replace('Setup')`

---

## Step 13 — DoneScreen

**Goal:** Confirm the routine completed and offer a clean reset path back to Setup.

**File:** `src/screens/DoneScreen.tsx` (~70 lines)

**UI:**
- Large moon emoji (or text "🌙") centered
- Heading "Your baby is asleep"
- Subtext "White noise is playing"
- "Start again" button → `navigation.reset({ index: 0, routes: [{ name: 'Setup' }] })` (clears the stack so Back doesn't return to Monitoring)

No logic beyond navigation reset.

---

## Step 14 — E2E tests with Maestro

**Goal:** Validate full UI flows on a real Android device or emulator without touching live Owlet or Spotify APIs, using a build-time mock mode.

### Mock mode

Add to `app.config.js`:
```js
extra: { mockMode: process.env.MOCK_MODE === '1' }
```

In `SetupScreen`, when `Constants.expoConfig.extra.mockMode` is true:
- Pre-fill Owlet credentials with `test@example.com` / `password`
- Mark Spotify as connected (skip OAuth)
- Pass a mock `Owlet` that returns the fixture reading with HR = 90 after 2 ticks

Build the mock APK: `MOCK_MODE=1 npx expo run:android`.

### Maestro flows

**Install Maestro:** `curl -Ls "https://get.maestro.mobile.dev" | bash`

**`e2e/01_form_validation.yaml`** (~25 lines):
```yaml
appId: com.enysmones.babu
---
- launchApp
- assertVisible: "babu"
- tapOn: "Start Routine"       # should still be disabled
- assertNotVisible: "Monitoring"
- tapOn: "Connect Spotify"
- assertVisible: "Connected"
- tapOn: "Start Routine"
- assertVisible: "running"
```

**`e2e/02_happy_path.yaml`** (~30 lines, mock mode APK):
```yaml
# Verifies: Setup → Monitoring (shows vitals) → auto-advance to Done
appId: com.enysmones.babu
---
- launchApp
- tapOn: "Start Routine"
- assertVisible: "running"
- waitForAnimationToEnd
- assertVisible: "transitioning"
- waitForAnimationToEnd
- assertVisible: "Your baby is asleep"
```

**`e2e/03_stop_routine.yaml`** (~20 lines):
```yaml
appId: com.enysmones.babu
---
- launchApp
- tapOn: "Start Routine"
- assertVisible: "running"
- tapOn: "Stop"
- assertVisible: "babu"   # back on Setup
```

**Run:** `maestro test e2e/`

---

## Step 15 — Clean up obsolete files

**Goal:** Remove all code that predates the React Native migration. The `app/` directory is now the entire project; the root-level Node.js and Python files are dead weight.

**Files to delete:**
```bash
# Python
rm main.py
rm lib/owlet.py
rm lib/spotify.py
rm pyproject.toml
rm poetry.toml
rm poetry.lock

# Node.js web server
rm server.js
rm lib/owlet.js
rm lib/spotify.js
rm lib/routine.js
rm -rf public/
rm package.json
rm package-lock.json

# Empty lib/ directory (nothing left in it)
rmdir lib/
```

**Also remove from `.gitignore`** any entries that only applied to the old stack (`.cache`, `.spotify-token.json`, `node_modules` at the root, `__pycache__`, `*.pyc`, `.env`). Keep entries that still apply to `app/`.

**Update `README.md`** to remove the Python and Node.js sections and reflect that the project is now a React Native app only.

**Update `CLAUDE.md`** to remove the Python and Node.js architecture notes, the old repository layout, and the old running/debugging instructions. Replace with the `app/` layout and `npx expo run:android`.

**Verify:** `git status` shows only deletions and README/CLAUDE.md edits; `cd app && npm test` still passes; `npx expo run:android` still builds and runs cleanly.

---

## Summary

| Step | File(s) | Concept | Done |
|---|---|---|---|
| 1 | `app/` scaffold | Expo + TS + Jest setup | ✅ |
| 2 | `src/lib/types.ts`, `constants.ts` | Shared types and config | ✅ |
| 3 | `src/lib/owlet.ts` | Owlet client TypeScript port | |
| 4 | `src/lib/__tests__/owlet.test.ts` | Owlet unit tests + fixtures | |
| 5 | `src/lib/spotifyApi.ts` | Spotify Web API (direct fetch) | |
| 6 | `src/lib/spotifyAuth.ts` | OAuth PKCE + SecureStore | |
| 7 | `src/lib/__tests__/spotifyApi.test.ts` | Spotify unit tests | |
| 8 | `src/hooks/useRoutine.ts` | Routine state machine hook | |
| 9 | `src/hooks/__tests__/useRoutine.test.ts` | Routine hook tests | |
| 10 | `App.tsx` + screen stubs | Navigation wiring | |
| 11 | `src/screens/SetupScreen.tsx` | Credential form + OAuth | |
| 12 | `src/screens/MonitoringScreen.tsx` | Live vitals + controls | |
| 13 | `src/screens/DoneScreen.tsx` | Completion + stack reset | |
| 14 | `e2e/*.yaml` | Maestro E2E flows | |
| 15 | Delete Python + Node.js files | Repo cleanup | |
