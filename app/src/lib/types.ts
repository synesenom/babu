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

export type SpotifyAccessToken = string;
export type SpotifyDeviceId = string;

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
