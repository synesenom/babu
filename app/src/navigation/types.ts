import type { Owlet } from '../lib/owlet';
import type { SpotifyTokens } from '../lib/types';

export type RootStackParamList = {
  Setup: undefined;
  Monitoring: { owlet: Owlet; tokens: SpotifyTokens; deviceName: string; pollIntervalMs?: number };
  Done: undefined;
};
