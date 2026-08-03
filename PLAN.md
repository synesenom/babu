# PLAN — Yoto player support

Add Yoto Player as an alternative music backend alongside Spotify. At setup the user
picks which player drives the routine; everything else — Owlet login, vitals polling,
the HR threshold, the transition state machine — stays exactly as it is today.

## Why this shape

`useRoutine` currently imports `spotifyApi` and `spotifyAuth` directly and reasons in
Spotify vocabulary (`SpotifyPlayback`, playlist URIs, device IDs). The routine logic
itself — lock in a transition when HR drops, wait for the current track's tail, switch
to white noise, otherwise keep the lullaby alive — has nothing to do with Spotify. So
the work is: extract that vocabulary behind a `PlayerBackend` interface, prove the
interface by re-expressing Spotify through it with zero behaviour change, then add a
second implementation.

Yoto differs from Spotify in two ways that shape the design:

- **Control is MQTT, not REST.** Commands are published to
  `/device/{deviceId}/command/...` over WSS; playback state arrives as pushed events on
  `/device/{deviceId}/data/events`. The backend therefore holds a live connection and
  caches the latest event, and `getPlayback()` reads that cache rather than making a
  network round trip. The routine keeps polling on `POLL_INTERVAL_MS` — it just reads a
  fresher local value.
- **A physical card is not required.** Yoto cards are NFC keys holding a card ID; the
  audio itself lives on Yoto's servers. `card/start` takes a **card URI**
  (`https://yoto.io/<cardId>`), so any content in the family library — including the
  free in-app sleep sounds — can be streamed to the player with nothing in the slot.
  The Yoto config is therefore **two content targets**, one per role, each
  `{ uri, chapterKey?, trackKey? }`. That covers two chapters of one card, two separate
  cards, or card-free app content, without the routine caring which.

Two unknowns must be closed before any Yoto code is written, hence the two spikes in
Phase 0: the exact REST/auth surface, and whether an MQTT client is viable under Hermes.

## Prerequisite: the content has to exist first

The routine plays content that is already in the family library — it does not create it.
Before any of this can be configured there must be:

- a **lullaby playlist** — Chopin's compositions are public domain, but *recordings* are
  not, so the audio needs to come from a public-domain or CC source
  ([Musopen](https://musopen.org/) hosts a complete Chopin collection), a DRM-free
  purchase, or a CD rip. Upload it as a Make Your Own playlist in the Yoto app.
- a **white-noise target** — either Yoto's free in-app Sleep Sounds, if Step 1 confirms
  they are API-addressable, or a MYO playlist containing the same audio.

Neither needs to be linked to a physical card. Both appear in `GET /content/mine` with a
`cardId`, which is what the app config stores.

Yoto's API can also create playlists programmatically — request an upload URL from
`/media/transcode/audio/uploadUrl`, `PUT` the file, poll
`/media/upload/{uploadId}/transcoded`, then `POST /content`. That is deliberately **out
of scope**: this is a one-time setup better done in the Yoto app than built into a
bedtime monitor.

## The one hard constraint

**Players cannot be powered on remotely.** Playback commands have no effect while the
player is off or disconnected — it has to be woken by a button press or a card
insertion. For a routine that runs unattended all night, this is the difference between
the feature working and silently doing nothing, so Step 1 must establish whether a Yoto
Mini left on the charger stays connected through the night, and what the backend should
do when it finds the player offline.

## Verified reference points

Confirmed from [yoto.dev](https://yoto.dev/) while drafting this plan. Anything not
listed here is unverified and belongs to Step 1 or Step 2.

| Item | Value |
|---|---|
| Authorize endpoint | `https://login.yotoplay.com/authorize` |
| Token endpoint | `https://login.yotoplay.com/oauth/token` |
| `audience` param | `https://api.yotoplay.com` (required) |
| PKCE | Mandatory, `S256` |
| Refresh tokens | **Single use** — every refresh returns a new one; the old one dies |
| REST base | `https://api.yotoplay.com` |
| Scopes needed | `family:devices:control`, `family:devices:view`, `family:library:view`, `offline_access` |
| MQTT broker | `wss://aqrphjqbp3u2z-ats.iot.eu-west-2.amazonaws.com/mqtt` |
| MQTT username | `{deviceId}?x-amz-customauthorizer-name=PublicJWTAuthorizer` |
| MQTT password | JWT access token with `family:devices:control` |
| MQTT client ID | `DASH{deviceId}` |
| Connection options | `ALPNProtocols: ["x-amzn-mqtt-ca"]` |
| Idle timeout | ~5 min — publish an events request every 4 m 55 s |
| Command topics | `card/start`, `card/pause`, `card/resume`, `card/stop`, `volume/set`, `ambients/set`, `sleep-timer/set` |
| `card/start` payload | `uri` (required, `https://yoto.io/<cardId>`), `chapterKey`, `trackKey`, `secondsIn`, `cutOff`, `anyButtonStop` |
| Physical card | Not required — content streams from the library to an awake player |
| Remote power-on | **Not possible** — commands are ignored while the player is off or disconnected |
| Event fields | `cardId`, `chapterKey`, `chapterTitle`, `trackKey`, `trackTitle`, `position`, `trackLength`, `playbackStatus`, `sleepTimerActive` |
| Status fields | `batteryLevel`, `playingStatus`, `volume` |

Every step below follows the project's TDD rule: write the test file first, run it,
confirm it fails, then implement.

---

## Phase 0 — Close the unknowns

### Step 1 — Verify the Yoto REST and OAuth surface

Research only, no runtime code. Register a developer app at
[dashboard.yoto.dev](https://dashboard.yoto.dev/) and confirm against a real account:

- Whether a native redirect URI (`babu://auth`) is accepted for a public client, or
  whether the device-code flow is required instead.
- The exact request/response shape of `GET /device-v2/devices/mine`,
  `GET /device-v2/{deviceId}/status`, and `GET /card/family/library`.
- How to enumerate a card's chapters (`GET /content/{cardId}` or equivalent) and what
  a `chapterKey` looks like in practice (`"01"`, `"02"`, …).
- That an **unlinked MYO playlist** is addressable: `GET /content/mine` returns MYO
  items with a `cardId` even when no physical card is linked, and
  `GET /content/{cardId}` returns its chapters. Confirm that `cardId` works as
  `https://yoto.io/<cardId>` in a `card/start` payload — this is what makes the
  card-free setup work at all.
- Whether the free in-app sleep sounds (white / pink / brown noise) appear in
  `GET /card/family/library` or `GET /content/mine` with their own card IDs, or need to
  be linked to a Make Your Own playlist first.
- Whether `card/start` on a multi-chapter playlist auto-advances through the chapters
  and then stops, and whether `card/resume` resumes in place — see the restart-semantics
  note in Step 10.
- **Player availability overnight:** whether a Mini left on the charger stays connected
  to MQTT all night, how long it takes to drop off after the last playback, and whether
  anything short of a physical button press brings it back.
- Rate limits and anything in the terms of service that affects a hobby app.

**Deliverable:** `docs/yoto-api-notes.md` with confirmed URLs, headers, sample JSON
responses (credentials redacted), and the card URIs and chapter keys for both roles.

**Acceptance:** every URL and field name used in Steps 6–10 traces back to this file.

### Step 2 — Spike the MQTT transport under Hermes

The one genuine technical risk. Two candidate approaches:

1. **`mqtt.js` + polyfills** — needs `buffer`, `process`, `events`, `readable-stream`
   shimmed via a Metro `resolver.extraNodeModules` config. Well-trodden but adds
   bundle weight and a Metro config the project does not currently have.
2. **Minimal hand-rolled MQTT 3.1.1 client** over React Native's native `WebSocket` —
   only CONNECT / SUBSCRIBE / PUBLISH / PINGREQ packets are needed. Perhaps 200 lines,
   no polyfills, no Metro changes, fully unit-testable.

Build a throwaway prototype that connects to the broker, subscribes to
`/device/{deviceId}/data/events`, and logs one event on a real device.

**Deliverable:** decision recorded in `docs/yoto-api-notes.md`, plus whichever of a
`metro.config.js` or a packet-codec sketch the decision implies.

**Acceptance:** a real event from a real Yoto Mini observed in the Metro logs, and the
`ALPNProtocols` requirement confirmed either satisfied or unnecessary over WSS.

---

## Phase 1 — Player abstraction (no behaviour change)

### Step 3 — Define `PlayerBackend` and neutral playback types

Add to `app/src/lib/types.ts`:

```ts
export type PlayerKind = 'spotify' | 'yoto';

export interface PlaybackState {
  is_playing: boolean;
  title: string;             // track name / chapter title
  subtitle: string;          // artist / card title
  remaining_seconds: number | null;
  source: PlayerKind;
}

export interface PlayerBackend {
  readonly kind: PlayerKind;
  connect(): Promise<void>;          // no-op for Spotify; MQTT connect for Yoto
  getPlayback(): Promise<PlaybackState | null>;
  playLullaby(): Promise<void>;
  playWhiteNoise(): Promise<void>;
  dispose(): Promise<void>;          // no-op for Spotify; MQTT teardown for Yoto
}
```

`RoutineState.nowPlaying` becomes `PlaybackState | null`. `SpotifyPlayback` stays as
the raw Spotify wire shape.

Deliberately **not** in the interface: volume, seek, device enumeration. The routine
does not use them; adding them now would mean writing Yoto code with no test to justify
it.

**Test first:** `app/src/lib/__tests__/types.test.ts` — a compile-level test asserting a
minimal stub object satisfies `PlayerBackend`.

**Acceptance:** `npm test` green; no runtime behaviour changed.

### Step 4 — `SpotifyPlayer` adapter

New `app/src/lib/spotifyPlayer.ts` implementing `PlayerBackend` over the existing
`spotifyApi` / `spotifyAuth` functions. Constructor takes `{ tokens, deviceName,
clientId }`. It owns the details currently inlined in `useRoutine`: the
`getValidToken` refresh-before-every-call, `findDeviceByName`, and `startPlaylist` with
`CHOPIN_PLAYLIST` / `WHITENOISE_PLAYLIST`. `connect()` and `dispose()` are no-ops.
`getPlayback()` maps `SpotifyPlayback` → `PlaybackState`.

**Test first:** `app/src/lib/__tests__/spotifyPlayer.test.ts` — mock `spotifyApi` and
`spotifyAuth`; assert token refresh happens before each call, that `playWhiteNoise()`
resolves the device then starts the white-noise playlist, and that a missing device does
not throw.

**Acceptance:** the adapter reproduces, call for call, what `useRoutine` does today.

### Step 5 — `useRoutine` consumes `PlayerBackend`

Change the signature from `(owlet, tokens, deviceName, pollIntervalMs, monitorOnly,
clientId)` to `(owlet, player: PlayerBackend | null, pollIntervalMs, monitorOnly)`.
Replace the three `spotifyApi` call sites with `player.getPlayback()`,
`player.playLullaby()`, `player.playWhiteNoise()`. Call `connect()` in `start()` and
`dispose()` in `stop()` and on unmount.

Everything else is untouched: `tickingRef` serialization, `transitionRef` latching,
`switchingRef` idempotency, the poll-driven tail detection, and the comments explaining
why each exists. `trackEnding` still keys off `remaining_seconds === null ||
remaining_seconds < RESTART_THRESHOLD_SECONDS`.

**Test first:** rewrite `app/src/hooks/__tests__/useRoutine.test.ts` against a fake
`PlayerBackend` instead of mocked Spotify modules. Every existing test case must survive
the rewrite — especially the regression tests for transition timing (commits `d487007`,
`cbabe7d`, `c2d6088`) and tick serialization (`03b74db`).

**Acceptance:** the hook has no `spotify` import left, and the full suite is green.

---

## Phase 2 — Yoto library

### Step 6 — Yoto configuration and constants

- `app/app.config.js`: expose `yotoClientId` from `YOTO_CLIENT_ID`.
- `app/src/lib/constants.ts`: `YOTO_SCOPES`, `YOTO_AUTH`, `YOTO_API_BASE`,
  `YOTO_MQTT_URL`, `YOTO_MQTT_KEEPALIVE_MS = 295_000`.
- `app/.env.example` (new) documenting `SPOTIFY_CLIENT_ID`, `YOTO_CLIENT_ID`,
  `MOCK_MODE`.

Card and chapter IDs are **not** constants — they are per-family and get selected in
the UI at Step 12.

**Test first:** extend the constants test to assert the scope list contains
`family:devices:control` and `offline_access`, and that the keepalive is under the
5-minute idle timeout.

### Step 7 — `yotoAuth.ts`

Mirror `spotifyAuth.ts`: `expo-auth-session` authorization-code + PKCE against the
verified endpoints, `audience` passed as an extra param, tokens in `expo-secure-store`
under `babu_yoto_tokens`, plus `loadStoredTokens` / `saveTokens` / `clearTokens` /
`getValidToken(clientId)` and a `useYotoAuth(clientId)` hook.

The one real difference from Spotify: **refresh tokens are single-use.** `getValidToken`
must persist the new refresh token before returning, and a failed refresh must clear
storage rather than leave a dead token behind — otherwise an overnight run dies at the
first refresh and never recovers.

**Test first:** `app/src/lib/__tests__/yotoAuth.test.ts` — a valid token is returned
without a network call; an expired token triggers refresh and persists *both* new
tokens; a failed refresh clears storage and returns `null`.

### Step 8 — `yotoApi.ts` (REST)

Direct `fetch`, no SDK, matching `spotifyApi.ts` in style — including a `YotoError`
class and a `MOCK_TOKEN` short-circuit in every function.

- `getPlayers(token)` → `{ deviceId, name, online }[]`
- `getDeviceStatus(token, deviceId)` → `{ batteryLevel, playingStatus, volume }`
- `getLibrary(token)` → `{ cardId, title }[]`
- `getCardChapters(token, cardId)` → `{ chapterKey, title }[]`

**Test first:** `app/src/lib/__tests__/yotoApi.test.ts` using `jest-fetch-mock` with
fixtures captured in Step 1, added to `__mocks__/fixtures.ts`. Cover the happy path,
a 401, and an empty library.

### Step 9 — `yotoMqtt.ts` (transport)

Implements whichever approach Step 2 selected, behind a small interface so the choice
stays swappable:

```ts
connect(token, deviceId): Promise<void>
publish(topic, payload): Promise<void>
onEvent(cb: (evt: YotoEvent) => void): () => void
disconnect(): Promise<void>
```

Responsibilities: subscribe to `data/events` and `data/status`; parse JSON payloads into
a typed `YotoEvent`; keepalive publish every `YOTO_MQTT_KEEPALIVE_MS`; reconnect with
backoff on drop; refresh the JWT before reconnecting, since the password is an access
token that expires mid-night.

**Test first:** `app/src/lib/__tests__/yotoMqtt.test.ts` against a fake WebSocket —
assert the connect URL/username/clientId are built correctly, that a keepalive fires on
schedule under fake timers, that malformed JSON does not crash the handler, and that a
drop schedules a reconnect.

### Step 10 — `YotoPlayer` adapter

New `app/src/lib/yotoPlayer.ts` implementing `PlayerBackend` over Steps 7–9.
Constructor takes `{ tokens, deviceId, lullaby, whiteNoise, clientId }`, where each
role is a content target:

```ts
export interface YotoTarget {
  uri: string;            // https://yoto.io/<cardId>
  chapterKey?: string;
  trackKey?: string;
}
```

The two roles are independent, so this covers two chapters of one card, two separate
cards, or card-free app content such as the free sleep sounds — the adapter does not
care which.

- `connect()` → MQTT connect + subscribe; caches the latest event.
- `getPlayback()` → maps the cached event to `PlaybackState`;
  `remaining_seconds = trackLength - position`, `is_playing = playbackStatus ===
  'playing'`, `title = trackTitle`, `subtitle = chapterTitle`. Returns `null` when no
  event has arrived yet or `playbackStatus === 'stopped'` — which makes the routine's
  existing `remaining_seconds === null` branch restart the lullaby, exactly as it does
  for a silent Spotify device.
- `playLullaby()` / `playWhiteNoise()` → publish `card/start` with that role's `uri`
  and, when set, its `chapterKey` / `trackKey`.
- `dispose()` → disconnect.

**Test first:** `app/src/lib/__tests__/yotoPlayer.test.ts` with a fake transport —
assert the published topic and payload for each role (including a target with no
`chapterKey`, which must omit the field rather than send `undefined`), the event →
`PlaybackState` mapping, and the stale/absent-event null cases.

**Restart semantics.** The routine's "keep the lullaby alive" branch calls
`playLullaby()` whenever the current track is ending or nothing is playing. On Spotify
that re-issues the playlist context. On Yoto, a bare `card/start` restarts the playlist
**from the top**, so a multi-chapter Chopin playlist would replay its first nocturne all
evening. `playLullaby()` must therefore be position-aware: when the cached event shows
the player paused or mid-playlist, prefer `card/resume`, or re-issue `card/start` with
the current `chapterKey` / `trackKey` and `secondsIn`. Only a genuine stop-at-the-end
should restart from the top. Cover this with an explicit test — it is the one place
where the Spotify-shaped logic does not transfer cleanly.

**Offline players.** Since a player cannot be powered on remotely, a command published
to a sleeping player is silently dropped. `connect()` should check `getPlayers()` for
the device's `online` flag and fail loudly if it is off, and `getPlayback()` should
distinguish "no event yet because the player is offline" from "nothing playing" — the
latter restarts the lullaby, the former must surface an error. Getting this wrong means
a night of silence with the UI showing `running`.

**Open question for Step 1 to answer:** whether `card/start` works when a *different*
physical card is inserted, and what happens if a card is ejected mid-routine. If a
foreign card blocks playback, `getPlayback()` should surface that as an error too.

---

## Phase 3 — UI and wiring

### Step 11 — Player selection in `SetupScreen`

A "Player" section with a `Picker` (Spotify / Yoto) above the existing Spotify card,
persisted to `SecureStore` under `player_kind` and restored on mount. The Spotify
section renders only for `spotify`, the Yoto section only for `yoto`. Owlet and Options
sections are untouched.

`Start Routine` stays disabled until the selected backend is fully configured — for
Yoto that means connected **and** a player plus a content target chosen for each of the
two roles.

**Test first:** a new `app/src/screens/__tests__/SetupScreen.test.tsx` — switching the
picker swaps which section renders, the choice survives a remount, and the start button
gating is correct per backend.

### Step 12 — Yoto connect and content pickers

Inside the Yoto section: a "Connect Yoto" button driving `useYotoAuth`, then, once
connected, a player picker plus **two independent content pickers** — one for the
lullaby role, one for white noise. Each is a card picker (from `getLibrary()`) with an
optional chapter picker (from `getCardChapters()`) that appears only when the chosen
card has more than one chapter. Selections persist to `SecureStore` as `YotoTarget`s.

The two roles are independent by design: the family's current setup has Chopin and white
noise as two chapters of one card, but a user may equally point white noise at the free
in-app brown-noise content and the lullaby at a different card. Both must work.

Show a clear inline error when the account has no players. Do **not** require the card
to have two chapters — a single-chapter card is valid for a role.

**Test first:** extend `SetupScreen.test.tsx` with mocked `yotoApi` — pickers populate,
changing a card refetches and resets that role's chapter only, a single-chapter card
hides the chapter picker and stores a target with no `chapterKey`, the two roles can
hold different cards, and persisted selections are restored.

### Step 13 — Navigation and `MonitoringScreen`

`RootStackParamList.Monitoring` currently carries `{ tokens, deviceName }`. Replace with
a serializable descriptor:

```ts
Monitoring: {
  owlet: Owlet;
  player: PlayerConfig;   // discriminated union on kind
  pollIntervalMs?: number;
  monitorOnly?: boolean;
}
```

`MonitoringScreen` builds the backend from the descriptor via a `createPlayer(config)`
factory (new `app/src/lib/playerFactory.ts`) inside a `useMemo`, and passes it to
`useRoutine`. The "Now Playing" card reads `title` / `subtitle` from `PlaybackState`, so
it works unchanged for both backends.

**Test first:** `app/src/lib/__tests__/playerFactory.test.ts` — each descriptor kind
produces the right backend; an unknown kind throws.

### Step 14 — Mock mode for Yoto

`MOCK_MODE=1` must exercise the Yoto path without network or hardware, matching how
Spotify already short-circuits on `MOCK_TOKEN`:

- `yotoApi` returns fixture players, cards, and chapters.
- `yotoMqtt` is replaced by an in-memory fake that emits a scripted event sequence —
  a long chapter, then one in its final seconds — so the transition is reachable.
- `SetupScreen` gets a mock-connect path mirroring `handleMockConnect`.

**Test first:** assert every `yotoApi` function short-circuits on `MOCK_TOKEN` without
touching `fetch`.

---

## Phase 4 — Verification and documentation

### Step 15 — E2E flow for the Yoto path

New `app/e2e/04_yoto_happy_path.yaml`, modelled on `02_happy_path.yaml`: launch, select
Yoto, mock-connect, pick card and chapters, start, assert vitals render, assert the
transition, assert the Done screen. Add the `testID`s the flow needs in Step 11/12
rather than retrofitting them here.

**Acceptance:** `maestro test e2e/` passes against a `MOCK_MODE=1` build with both the
Spotify and Yoto flows green.

### Step 16 — Documentation

- `README.md`: Yoto setup (developer app registration, `YOTO_CLIENT_ID`, picking the
  card and chapters), and note that Yoto needs no subscription where Spotify needs
  Premium. Keep the coverage badge URL format intact — CI rewrites it with `sed`.
- `CLAUDE.md`: update the repository layout tree, add a "Player backends" architecture
  section describing `PlayerBackend` and the two adapters, document the Yoto MQTT
  constants, and revise the routine state-machine section to say the tick reads from a
  `PlayerBackend` rather than from Spotify.

**Acceptance:** a fresh reader can set up either backend from the README alone.

---

## Risks

| Risk | Mitigation |
|---|---|
| MQTT unusable under Hermes | Step 2 spikes it before any dependent work; hand-rolled WS client is the fallback |
| Single-use refresh tokens strand an overnight run | Step 7 persists the rotated token before returning and clears on failure; explicitly tested |
| Broker drops the connection mid-night | Keepalive under the 5-minute idle window plus reconnect-with-backoff in Step 9 |
| Player asleep or offline — commands silently dropped, no remote power-on | Step 1 measures overnight availability; Step 10 fails loudly on an offline player instead of showing `running` over silence |
| Physical card ejected or swapped mid-routine | Step 1 determines the behaviour; Step 10 surfaces it as an error |
| Unofficial-API drift | Yoto's API is first-party and documented, so lower risk than the Owlet chain; pin nothing to undocumented fields |
| Scope creep into volume/lights/sleep timer | `PlayerBackend` stays minimal; extras are follow-up work, not part of this plan |

## Summary

| # | Step | Issue | Depends on | Done |
|---|---|---|---|---|
| 1 | Verify the Yoto REST and OAuth surface | #27 | — | |
| 2 | Spike the MQTT transport under Hermes | #29 | #27 | |
| 3 | Define `PlayerBackend` and neutral playback types | #28 | — | |
| 4 | `SpotifyPlayer` adapter | #30 | #28 | |
| 5 | `useRoutine` consumes `PlayerBackend` | #32 | #30 | |
| 6 | Yoto configuration and constants | #31 | #27 | |
| 7 | `yotoAuth.ts` | #33 | #31 | |
| 8 | `yotoApi.ts` (REST) | #34 | #33 | |
| 9 | `yotoMqtt.ts` (transport) | #35 | #29, #33 | |
| 10 | `YotoPlayer` adapter | #37 | #28, #34, #35 | |
| 11 | Player selection in `SetupScreen` | #36 | #32 | |
| 12 | Yoto connect and content pickers | #38 | #34, #36 | |
| 13 | Navigation and `MonitoringScreen` | #39 | #36, #37 | |
| 14 | Mock mode for Yoto | #40 | #38, #39 | |
| 15 | E2E flow for the Yoto path | #41 | #40 | |
| 16 | Documentation | #42 | #41 | |

Phase 1 (steps 3–5) has no dependency on the Yoto research, so it can proceed in
parallel with Phase 0.
