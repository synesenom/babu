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
│   │   ├── transition.ts         Chopin → white-noise decisions (pure functions)
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
- Each tick: Owlet read → Spotify playback read → either advance the transition (once HR has dropped below threshold) or keep music alive (restart Chopin when `remaining_seconds < RESTART_THRESHOLD_SECONDS` or nothing playing).
- `monitorOnly` flag disables all playback control.

### The transition (`app/src/lib/transition.ts`)

The requirement is one sentence: **when the baby falls asleep, let the nocturne
that is playing finish, then put white noise on.** The decisions live in
`transition.ts` as pure functions so that sentence is actually written down
somewhere and can be tested without React, timers, or Spotify.

Three rules carry the whole design, and each exists because breaking it produced
a specific reported bug:

1. **Commit to one track.** `captureTarget()` records the track id, its device,
   and the wall-clock time it will end. Every later poll asks only "is *that*
   track over yet" (`evaluateWait()`). The earlier version inferred the boundary
   from differences between consecutive polls, which made every hiccup in the
   poll stream look identical to the track ending.
2. **Missing data is not a signal.** `/me/player` returns 204 routinely, and
   Spotify reports `is_playing: false` for a moment after any play call. A single
   such sample used to commit the routine to switching immediately, cutting a
   nocturne short by minutes. It now takes `BLIND_POLLS_BEFORE_IDLE` consecutive
   blind polls before silence is believed.
3. **Verify the switch.** `startPlaylist` returning 2xx is not white noise coming
   out of a speaker — Spotify answers `202 Accepted` when it is merely waking a
   device. The routine reports `done` only once a later poll shows
   `context_uri === WHITENOISE_PLAYLIST`, and re-issues the play call on every
   poll until then.

Two deliberate choices worth not "fixing":

- **The switch is biased late.** It fires on the first poll after the committed
  track has run its length, so white noise may bleed a few seconds into whatever
  the playlist started next. That is intentional — the original version behaved
  this way and it is preferred to clipping the quiet final bars of a nocturne. Do
  not reintroduce a "switch N seconds before the end" window; it gets exactly one
  chance per track and is what made the switch unreliable.
- **The detection poll does nothing but announce itself.** `transitioning` has to
  be a state the screen can render before anything acts on it. Dispatching
  `TRANSITIONING` and `DONE` inside one tick is what made the app jump to the Done
  screen with no transition ever visible.

`RoutineState.waitingFor` carries the committed track's name so the monitoring
screen and the ongoing notification can both say which piece has to finish.

Mock mode models playback (`resetMockPlayback()` / `mockPlayback()` in
`spotifyApi.ts`) rather than reporting nothing, so the transition is reachable and
completable in a `MOCK_MODE=1` build. A mock that always answers "nothing playing"
makes the whole mechanism unexercisable.

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
