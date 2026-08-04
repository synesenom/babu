import type { SpotifyPlayback } from './types';
import { WHITENOISE_PLAYLIST } from './constants';

/**
 * The Chopin-to-white-noise transition, as pure decisions.
 *
 * The rule the parent actually asked for is one sentence: *when the baby is
 * asleep, let the nocturne that is playing finish, then put white noise on*.
 * The previous implementation never wrote that sentence down. It inferred the
 * track boundary from differences between consecutive polls, which meant every
 * hiccup in the poll stream — a 204, a paused instant, a natural track change —
 * was indistinguishable from "the track ended", and any one of them committed
 * the routine to switching immediately.
 *
 * So the routine commits to a specific track up front (`captureTarget`) and
 * afterwards only ever asks "is *that* track over yet" (`evaluateWait`). A poll
 * that returns nothing tells us nothing, and is treated as such.
 */

/** The one track the routine has committed to waiting out. */
export interface TransitionTarget {
  /** Spotify's track id. The display name repeats; the id is identity. */
  trackId: string;
  trackName: string;
  /** The device the music is genuinely coming out of, per Spotify. */
  deviceId: string;
  /** Wall-clock ms at which this track is due to finish. */
  endsAt: number;
}

export interface WaitVerdict {
  /** Start white noise on this poll. */
  switchNow: boolean;
  /** Where to start it. Null only when nothing has ever reported a device. */
  deviceId: string | null;
  /** Consecutive polls that returned no usable playback, carried forward. */
  blindPolls: number;
  /** The committed target, possibly adopted on this poll. */
  target: TransitionTarget | null;
}

/**
 * Consecutive blind polls before the routine accepts that the silence is real
 * rather than a blip. One is never enough: a lone 204 from `/me/player` is
 * routine, and acting on it is precisely what cut nocturnes short by minutes.
 */
export const BLIND_POLLS_BEFORE_IDLE = 3;

/** Whether a poll told us anything about the music at all. */
function isUsable(playback: SpotifyPlayback | null): playback is SpotifyPlayback {
  return playback !== null && playback.is_playing;
}

/**
 * Commits to the track playing at sleep detection. Returns null when nothing is
 * playing — there is no track to wait out, and `evaluateWait` takes over the
 * job of deciding whether that silence is genuine.
 */
export function captureTarget(
  playback: SpotifyPlayback | null,
  now: number,
): TransitionTarget | null {
  if (!isUsable(playback)) return null;
  return {
    trackId: playback.track_id,
    trackName: playback.track_name,
    deviceId: playback.device_id,
    endsAt: now + playback.remaining_ms,
  };
}

/**
 * Decides, on one poll, whether the committed track is over.
 *
 * Deliberately biased late. The nocturne is allowed to finish; white noise may
 * bleed a few seconds into whatever the playlist started next, which is what
 * the original version of this routine did and what it should keep doing. The
 * alternative — switching inside a window before the end — cuts off the
 * quietest, most resolving part of the piece, and gets exactly one chance per
 * track to fire.
 *
 * It is over when the clock says the committed track has run its length, or
 * when the playlist has visibly moved on. The clock is the primary signal
 * because it still works across polls that were skipped or frozen by Doze.
 */
export function evaluateWait(
  target: TransitionTarget | null,
  playback: SpotifyPlayback | null,
  now: number,
  blindPolls: number,
): WaitVerdict {
  if (!isUsable(playback)) {
    // Nothing to read. Only a sustained streak is evidence of real silence.
    const blind = blindPolls + 1;
    return {
      switchNow: blind >= BLIND_POLLS_BEFORE_IDLE,
      deviceId: target?.deviceId ?? null,
      blindPolls: blind,
      target,
    };
  }

  // Sleep was detected during a gap, or the poll that detected it came back
  // empty. Music is playing after all, so wait it out rather than cut it off.
  if (target === null) {
    return {
      switchNow: false,
      deviceId: playback.device_id,
      blindPolls: 0,
      target: captureTarget(playback, now),
    };
  }

  const dueToHaveEnded = now >= target.endsAt;
  const movedOn = playback.track_id !== target.trackId;

  return {
    switchNow: dueToHaveEnded || movedOn,
    deviceId: playback.device_id,
    blindPolls: 0,
    target,
  };
}

/**
 * Whether white noise is genuinely playing right now.
 *
 * The switch is a claim about what the room sounds like, so it is checked
 * against Spotify rather than inferred from the status code of the play call.
 */
export function isWhiteNoisePlaying(playback: SpotifyPlayback | null): boolean {
  return isUsable(playback) && playback.context_uri === WHITENOISE_PLAYLIST;
}
