# CLAUDE.md

## Project overview

Bedtime automation: Owlet Smart Sock heart rate → Spotify playlist control. When the baby's BPM drops below the threshold, the app switches from Chopin nocturnes to white noise. The project is a single React Native (Expo) app for Android, written in TypeScript. It lives entirely in `app/`.

---

## Repository layout

```
app/
├── modules/
│   └── foreground-service/       Local Expo module (Android): keeps the routine
│                                 running while the app is backgrounded
├── src/
│   ├── screens/
│   │   ├── SetupScreen.tsx       Credential form + Spotify OAuth + device picker
│   │   ├── MonitoringScreen.tsx  Live vitals + routine controls
│   │   └── DoneScreen.tsx        Completion screen (resets nav stack)
│   ├── hooks/
│   │   └── useRoutine.ts         Polling loop + state machine (useReducer)
│   ├── lib/
│   │   ├── owlet.ts              Owlet client (Firebase → SSO → Ayla auth chain)
│   │   ├── spotifyApi.ts         Spotify Web API via direct fetch
│   │   ├── spotifyAuth.ts        OAuth PKCE + expo-secure-store persistence
│   │   ├── types.ts              Shared TypeScript types
│   │   ├── constants.ts          Thresholds, playlists, Owlet region endpoints
│   │   ├── foregroundService.ts  JS wrapper over the Android foreground service
│   │   ├── __tests__/            Jest unit tests
│   │   └── __mocks__/fixtures.ts Shared test fixtures
│   └── navigation/types.ts       React Navigation stack param types
├── e2e/                          Maestro E2E flows
├── app.config.js                 Expo config — injects app/.env values into expo.extra
├── app.json                      App metadata (name "Babu", package, scheme "babu://")
├── jest.config.js, jest.setup.ts Jest (jest-expo preset)
└── package.json
```

The old Python CLI and Node.js web server were removed after the React Native migration; only the app remains.

---

## Running the project

```bash
cd app
npm install
npx expo run:android     # build + install on emulator/device, starts Metro
npm test                 # Jest unit tests
npm run test:coverage    # coverage (CI updates the README badge from this)
maestro test e2e/        # E2E flows
```

`MOCK_MODE=1` in `app/.env` stubs all Spotify calls (`MOCK_TOKEN` short-circuits in `spotifyApi.ts`) for UI development.

---

## Key constants (`app/src/lib/constants.ts`)

| Constant | Value | Meaning |
|---|---|---|
| `HR_THRESHOLD` | 120 BPM | Sleep detection threshold |
| `POLL_INTERVAL_MS` | 5 000 ms | Owlet/Spotify polling interval |
| `RESTART_THRESHOLD_SECONDS` | 5 s | Restart Chopin if track is ending / nothing playing |
| `TRANSITION_TAIL_SECONDS` | 12 s (2 × poll + 2) | How close to the track end the white-noise switch may fire |
| `CHOPIN_PLAYLIST` | `spotify:playlist:5MKaz5wxcypYQLklyx34J2` | Lullaby playlist |
| `WHITENOISE_PLAYLIST` | `spotify:playlist:4Lj9ZugyG3SNEA9XAxGVwx` | Sleep playlist |

---

## Architecture notes

### Owlet auth chain (`app/src/lib/owlet.ts`)
Three-step flow:
1. Firebase sign-in (email + password → `idToken` JWT)
2. Owlet SSO mini-token request (Android spoofing headers bypass API key validation)
3. Ayla Networks `token_sign_in` → `access_token` used for all device calls

EU region uses separate Firebase/Ayla endpoints (`OWLET_REGIONS` in `constants.ts`). Token refresh is handled automatically before expiry. Both firmware variants supported: new `REAL_TIME_VITALS` JSON property and old individual properties (`HEART_RATE`, `OXYGEN_LEVEL`, …). Uses a manual `AbortController` for timeouts (Hermes has no `AbortSignal.timeout()`).

### `Owlet.read()` return shape
```
{
  heart_rate: number | null,
  oxygen: number | null,
  battery: number | null,
  movement: "still" | "moving" | null,
  sock_off: boolean,
  base_on: boolean,
  charging: boolean,
  sock_connected: boolean,
  dsn: string,
  timestamp: string,   // "YYYY-MM-DD HH:MM:SS"
  raw: object,         // full Ayla property dump
}
```

### Routine state machine (`app/src/hooks/useRoutine.ts`)
```
idle → running → transitioning → done
```
- `useReducer` for state; polling interval held in a `useRef` so it survives re-renders.
- Each tick: Owlet read → Spotify playback read → either transition (HR below threshold) or keep music alive (restart Chopin when `remaining_seconds < RESTART_THRESHOLD_SECONDS` or nothing playing).
- Once the transition is locked in, the white-noise switch becomes due on the first tick where **any** of these holds: nothing is playing / playback is paused; the track is within `TRANSITION_TAIL_SECONDS` of ending; or a track boundary passed between two polls (track name changed, or `remaining_seconds` jumped back up). The last one matters — gating only on the tail gives one chance per track, and a tick skipped by the in-flight guard silently costs a whole nocturne. Once due it stays due, so a failed switch retries on the next poll instead of going back to waiting.
- The switch reports `done` only if white noise actually started; a missing device or a refused play call surfaces as an error and keeps the routine polling.
- `monitorOnly` flag disables all playback control.

### Running in the background (`modules/foreground-service/`)
The routine must keep polling when the app is off screen — the parent puts the
phone down after sleep is detected, and the switch to white noise happens minutes
later. Android fights this in three separate ways, so the local Expo module
answers all three:

| Problem | Answer |
|---|---|
| The process is frozen or killed once backgrounded (Doze, OEM killers) | A foreground service (`dataSync` type) with an ongoing notification |
| The CPU suspends when the screen goes off | A partial wake lock held by the service |
| RN removes the choreographer callback behind **every JS timer** in `onHostPause` | The service is a `HeadlessJsTaskService`; an always-pending keep-alive task keeps timers alive (`JavaTimerManager` only clears the callback when no headless task is active) |

Because of the third point a JS `setInterval` cannot be trusted as the poll loop.
The service runs its own main-looper `Handler` and emits an `onTick` event at the
poll interval; `useRoutine` subscribes to that and falls back to `setInterval`
only where the native module does not exist (iOS, web, Expo Go, Jest).

The ongoing notification shows the live reading and updates every tick, which
makes it the quickest way to check the loop is still alive: if the text stops
advancing, the OS froze the routine.

Notes:
- Android 15 caps a `dataSync` foreground service at 6 h/day, so the service
  stops itself at 5 h 45 m rather than letting the platform kill the app.
- `POST_NOTIFICATIONS` is requested at start. Denying it only hides the
  notification; the service still runs.
- Native changes need a rebuild (`npx expo run:android`) — Fast Refresh does not
  reload them.

### Spotify
- `spotifyAuth.ts`: OAuth authorization-code + PKCE via `expo-auth-session`; tokens persisted in `expo-secure-store`. Redirect scheme `babu://auth`.
- `spotifyApi.ts`: direct `fetch` against the Web API — no SDK. Every function short-circuits on `MOCK_TOKEN`.
- Owlet credentials and region are also stored in `expo-secure-store` after first successful start.

### Configuration
`app/app.config.js` loads `app/.env` and exposes `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, and `MOCK_MODE` via `expo.extra`. No other env vars exist; Owlet credentials are entered in-app at runtime.

---

## Development approach

This project follows strict TDD. For every unit of code:

1. **Write the test first** — define the expected behaviour via a failing test
2. **Run it and confirm it fails** — a test that passes before implementation is not testing anything
3. **Write the minimum implementation to make it pass**
4. **Refactor** — clean up without changing behaviour; tests stay green throughout

Never write implementation code that does not have a corresponding test written first. If you are asked to implement a feature, write the test file first, confirm it fails (`cd app && npm test -- <file> --no-coverage`), then implement.

This applies to every change, including ones that look too small or too obvious to test. The regression tests in `useRoutine.test.ts` exist because several "obvious" playback-timing fixes were wrong in ways only a test caught.

### Working from issues

Planned work lives in GitHub issues, grouped into milestones — there is no plan file in the repository. Each issue carries its own **TDD** section naming the test file and the cases to write, and an **Acceptance** section. Treat both as the specification:

- Write the named test file first. If a case in it cannot be expressed against the interface you are building, that is a signal the interface is wrong — fix the interface, do not drop the case.
- An issue is not done until every acceptance criterion is met and the full suite passes, not just the file you touched.

`/resolve <issue-number>` runs the whole loop: research, plan, implement, validate.

### Code Health

Whenever you edit or create a `.ts`/`.tsx` file, check its Code Health immediately after saving:

1. Call the CodeScene `code_health_score` tool on the file.
2. If the score is **below 10.0**, call `code_health_review` on the same file and fix the identified code smells following the guidance it returns (boy scout rule — leave the file healthier than you found it).
3. After fixing, re-run `cd app && npx tsc --noEmit && npm test` to confirm nothing broke.

This rule applies to every `.ts`/`.tsx` file touched in any session, regardless of whether the edit was a bug fix, refactor, new feature, or incidental touch. If a smell cannot be fixed within reasonable scope (e.g., a god file that would require a major cross-file refactor), document why and proceed — use `/fix-smell <file>` to work through it properly in a follow-up.

When the user asks about the code health of a file or requests a code health review, always use CodeScene's MCP server: call `code_health_score` to get the score, and `code_health_review` to get the detailed review with identified smells and improvement guidance.

---

## Common tasks

### Change the sleep BPM threshold / playlists / poll interval
Edit `app/src/lib/constants.ts` (single source of truth — no duplicates anywhere).

### Debug the Spotify auth
Tokens live in `expo-secure-store` under the keys used in `spotifyAuth.ts`. In mock mode (`MOCK_MODE=1`) the OAuth flow is skipped entirely.

### CI
`.github/workflows/ci.yml` runs `npm run test:coverage` in `app/` on every push/PR and rewrites the coverage badge in `README.md` on pushes to `main` (commits with `[skip ci]`). Keep the badge URL format `https://img.shields.io/badge/coverage-...` intact — the workflow updates it with `sed`.

---

## Dependencies

- `expo` + `expo-auth-session`, `expo-secure-store`, `expo-web-browser`, `expo-constants`
- `@react-navigation/native` + `native-stack`
- `@react-native-picker/picker`
- Jest via `jest-expo`, `@testing-library/react-native`, `jest-fetch-mock`

Spotify Premium is required. The Owlet integration uses an unofficial API and may break on Owlet backend updates.
