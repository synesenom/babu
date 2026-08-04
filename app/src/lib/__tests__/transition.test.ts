import {
  captureTarget,
  evaluateWait,
  isWhiteNoisePlaying,
  BLIND_POLLS_BEFORE_IDLE,
} from '../transition';
import { WHITENOISE_PLAYLIST, CHOPIN_PLAYLIST } from '../constants';
import type { SpotifyPlayback } from '../types';

const NOW = 1_700_000_000_000;

function playing(overrides: Partial<SpotifyPlayback> = {}): SpotifyPlayback {
  return {
    is_playing: true,
    track_id: 'track-a',
    context_uri: CHOPIN_PLAYLIST,
    track_name: 'Nocturne Op. 9 No. 2',
    artist_name: 'Chopin',
    album_name: 'Nocturnes',
    progress_ms: 60_000,
    duration_ms: 270_000,
    remaining_ms: 210_000,
    remaining_seconds: 210,
    device_name: 'Bedroom speaker',
    device_id: 'speaker-1',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// captureTarget() — the routine commits to ONE named track at sleep detection.
// Everything afterwards is measured against that commitment, so a noisy poll
// cannot be mistaken for the track having ended.
// ---------------------------------------------------------------------------

describe('captureTarget()', () => {
  it('captures the track identity, its device, and when it will end', () => {
    const target = captureTarget(playing(), NOW);

    expect(target).toEqual({
      trackId: 'track-a',
      trackName: 'Nocturne Op. 9 No. 2',
      deviceId: 'speaker-1',
      endsAt: NOW + 210_000,
    });
  });

  it('captures the device the music is actually playing on, not a name the user typed', () => {
    const target = captureTarget(playing({ device_id: 'kitchen-hifi' }), NOW);

    expect(target!.deviceId).toBe('kitchen-hifi');
  });

  it('captures nothing when there is no playback at all', () => {
    expect(captureTarget(null, NOW)).toBeNull();
  });

  it('captures nothing when playback is paused — there is no track winding down', () => {
    expect(captureTarget(playing({ is_playing: false }), NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// evaluateWait() — the only question it answers is "has the track we committed
// to finished yet". Note what is NOT a trigger: a single missing sample.
// ---------------------------------------------------------------------------

describe('evaluateWait() — waiting out the committed track', () => {
  const target = captureTarget(playing(), NOW)!;

  it('waits while the committed track is still playing', () => {
    const verdict = evaluateWait(target, playing({ remaining_seconds: 120 }), NOW + 90_000, 0);

    expect(verdict.switchNow).toBe(false);
  });

  it('lets the nocturne play right to its end rather than switching early', () => {
    // The final seconds of a nocturne are the quietest part of it. Bleeding a
    // few seconds into the next track is the accepted cost of not clipping them.
    const verdict = evaluateWait(target, playing({ remaining_seconds: 4 }), NOW + 206_000, 0);

    expect(verdict.switchNow).toBe(false);
  });

  it('switches on the first poll after the committed track has run its length', () => {
    const verdict = evaluateWait(target, playing({ remaining_seconds: 246 }), NOW + 212_000, 0);

    expect(verdict.switchNow).toBe(true);
  });

  it('switches when the playlist has already moved to a different track', () => {
    const verdict = evaluateWait(
      target,
      playing({ track_id: 'track-b', remaining_seconds: 240 }),
      NOW + 212_000,
      0,
    );

    expect(verdict.switchNow).toBe(true);
  });

  it('switches when the committed track repeated — the wall clock says it ended', () => {
    // Same track id, position jumped back to the start. No delta heuristic
    // needed: the clock knows when the track we committed to was due to finish.
    const verdict = evaluateWait(
      target,
      playing({ remaining_seconds: 265 }),
      NOW + 215_000,
      0,
    );

    expect(verdict.switchNow).toBe(true);
  });

  it('switches on the wall clock even if polls were frozen straight through the tail', () => {
    // Doze froze the loop for two minutes; no poll ever saw the tail window.
    const verdict = evaluateWait(target, playing({ remaining_seconds: 180 }), NOW + 330_000, 0);

    expect(verdict.switchNow).toBe(true);
  });

  it('switches on the device the music is playing on now, not the captured one', () => {
    // The user moved playback to another speaker mid-nocturne.
    const verdict = evaluateWait(
      target,
      playing({ remaining_seconds: 250, device_id: 'kitchen-hifi' }),
      NOW + 212_000,
      0,
    );

    expect(verdict.switchNow).toBe(true);
    expect(verdict.deviceId).toBe('kitchen-hifi');
  });
});

// ---------------------------------------------------------------------------
// The regression that broke the app: ONE null or paused sample used to commit
// the routine to switching immediately, cutting a nocturne short by minutes.
// Missing data is missing data — never a signal.
// ---------------------------------------------------------------------------

describe('evaluateWait() — missing samples are not signals', () => {
  const target = captureTarget(playing(), NOW)!;

  it('does not switch on a single null playback (a transient 204)', () => {
    const verdict = evaluateWait(target, null, NOW + 10_000, 0);

    expect(verdict.switchNow).toBe(false);
    expect(verdict.blindPolls).toBe(1);
  });

  it('does not switch on a single paused sample (Spotify still spinning up a play call)', () => {
    const verdict = evaluateWait(target, playing({ is_playing: false }), NOW + 10_000, 0);

    expect(verdict.switchNow).toBe(false);
    expect(verdict.blindPolls).toBe(1);
  });

  it('keeps the committed target across a missing sample', () => {
    const verdict = evaluateWait(target, null, NOW + 10_000, 0);

    expect(verdict.target).toEqual(target);
  });

  it('forgets the blind streak as soon as a good sample arrives', () => {
    const verdict = evaluateWait(target, playing({ remaining_seconds: 150 }), NOW + 60_000, 2);

    expect(verdict.switchNow).toBe(false);
    expect(verdict.blindPolls).toBe(0);
  });

  it('treats a sustained blind streak as genuinely idle and switches', () => {
    const verdict = evaluateWait(target, null, NOW + 15_000, BLIND_POLLS_BEFORE_IDLE - 1);

    expect(verdict.switchNow).toBe(true);
    expect(verdict.blindPolls).toBe(BLIND_POLLS_BEFORE_IDLE);
  });

  it('falls back to the captured device when idle playback offers none', () => {
    const verdict = evaluateWait(target, null, NOW + 15_000, BLIND_POLLS_BEFORE_IDLE - 1);

    expect(verdict.deviceId).toBe('speaker-1');
  });
});

// ---------------------------------------------------------------------------
// Sleep detected while nothing was playing: there is no track to commit to, so
// the routine confirms the silence is real before acting on it.
// ---------------------------------------------------------------------------

describe('evaluateWait() — no track was ever committed', () => {
  it('confirms the silence over several polls, then switches', () => {
    let blindPolls = 0;
    let switched = false;

    for (let poll = 1; poll <= BLIND_POLLS_BEFORE_IDLE; poll += 1) {
      const verdict = evaluateWait(null, null, NOW + poll * 5_000, blindPolls);
      blindPolls = verdict.blindPolls;
      switched = verdict.switchNow;
    }

    expect(switched).toBe(true);
  });

  it('adopts the track instead when music turns out to be playing after all', () => {
    // The null at sleep detection was a blip: Chopin is playing fine. Wait for
    // it rather than cutting it off.
    const verdict = evaluateWait(null, playing(), NOW + 5_000, 1);

    expect(verdict.switchNow).toBe(false);
    expect(verdict.target).toEqual({
      trackId: 'track-a',
      trackName: 'Nocturne Op. 9 No. 2',
      deviceId: 'speaker-1',
      endsAt: NOW + 5_000 + 210_000,
    });
  });
});

// ---------------------------------------------------------------------------
// isWhiteNoisePlaying() — the switch is a claim about the room, so it gets
// checked against Spotify rather than inferred from an HTTP status.
// ---------------------------------------------------------------------------

describe('isWhiteNoisePlaying()', () => {
  it('confirms when the white-noise playlist is the playing context', () => {
    expect(isWhiteNoisePlaying(playing({ context_uri: WHITENOISE_PLAYLIST }))).toBe(true);
  });

  it('rejects when Chopin is still the playing context', () => {
    expect(isWhiteNoisePlaying(playing({ context_uri: CHOPIN_PLAYLIST }))).toBe(false);
  });

  it('rejects when the white-noise playlist is loaded but paused', () => {
    expect(
      isWhiteNoisePlaying(playing({ context_uri: WHITENOISE_PLAYLIST, is_playing: false })),
    ).toBe(false);
  });

  it('rejects when there is no playback to check', () => {
    expect(isWhiteNoisePlaying(null)).toBe(false);
  });

  it('rejects when playback has no context at all', () => {
    expect(isWhiteNoisePlaying(playing({ context_uri: null }))).toBe(false);
  });
});
