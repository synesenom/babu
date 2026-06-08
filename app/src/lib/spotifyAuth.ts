import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import { useState, useEffect } from 'react';
import { SPOTIFY_SCOPES } from './constants';
import { refreshAccessToken } from './spotifyApi';
import type { SpotifyTokens } from './types';

const SECURE_KEY = 'babu_spotify_tokens';

// Spotify Developer dashboard: add `babu://` and `exp://localhost:8081/--/` as redirect URIs
const DISCOVERY: AuthSession.DiscoveryDocument = {
  authorizationEndpoint: 'https://accounts.spotify.com/authorize',
  tokenEndpoint: 'https://accounts.spotify.com/api/token',
};

export async function loadStoredTokens(): Promise<SpotifyTokens | null> {
  const raw = await SecureStore.getItemAsync(SECURE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SpotifyTokens;
  } catch {
    return null;
  }
}

export async function saveTokens(tokens: SpotifyTokens): Promise<void> {
  await SecureStore.setItemAsync(SECURE_KEY, JSON.stringify(tokens));
}

export async function clearTokens(): Promise<void> {
  await SecureStore.deleteItemAsync(SECURE_KEY);
}

export async function getValidToken(clientId: string, clientSecret: string): Promise<string | null> {
  const tokens = await loadStoredTokens();
  if (!tokens) return null;
  if (Date.now() < tokens.expires_at - 60_000) {
    return tokens.access_token;
  }
  try {
    const refreshed = await refreshAccessToken(clientId, clientSecret, tokens.refresh_token);
    await saveTokens(refreshed);
    return refreshed.access_token;
  } catch {
    return null;
  }
}

export function useSpotifyAuth(
  clientId: string,
  clientSecret: string,
): {
  tokens: SpotifyTokens | null;
  promptAsync: () => Promise<void>;
  isLoading: boolean;
} {
  const [tokens, setTokens] = useState<SpotifyTokens | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const redirectUri = AuthSession.makeRedirectUri({ scheme: 'babu' });

  const [request, response, nativePromptAsync] = AuthSession.useAuthRequest(
    {
      clientId,
      scopes: SPOTIFY_SCOPES,
      redirectUri,
      usePKCE: true,
    },
    DISCOVERY,
  );

  useEffect(() => {
    if (response?.type !== 'success') return;
    const code = response.params.code;
    if (!code || !request?.codeVerifier) return;

    setIsLoading(true);
    (async () => {
      try {
        const body = new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: request.codeVerifier!,
        });

        const res = await fetch(DISCOVERY.tokenEndpoint!, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });

        const data = await res.json();
        const newTokens: SpotifyTokens = {
          access_token: data.access_token as string,
          refresh_token: data.refresh_token as string,
          expires_at: Date.now() + (data.expires_in as number) * 1000,
        };
        await saveTokens(newTokens);
        setTokens(newTokens);
      } finally {
        setIsLoading(false);
      }
    })();
  }, [response]);

  const promptAsync = async (): Promise<void> => {
    await nativePromptAsync();
  };

  return { tokens, promptAsync, isLoading };
}
