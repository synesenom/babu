import Constants from 'expo-constants';

const extra = Constants.expoConfig?.extra as
  | {
      spotifyClientId?: string;
      mockMode?: boolean;
    }
  | undefined;

export const CLIENT_ID = extra?.spotifyClientId ?? '';
export const MOCK_MODE = extra?.mockMode ?? false;
