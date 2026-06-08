import * as SecureStore from 'expo-secure-store';
import { refreshAccessToken } from '../spotifyApi';
import { loadStoredTokens, saveTokens, clearTokens, getValidToken } from '../spotifyAuth';
import type { SpotifyTokens } from '../types';

jest.mock('expo-secure-store');
jest.mock('../spotifyApi');

const mockGetItem = SecureStore.getItemAsync as jest.MockedFunction<typeof SecureStore.getItemAsync>;
const mockSetItem = SecureStore.setItemAsync as jest.MockedFunction<typeof SecureStore.setItemAsync>;
const mockDeleteItem = SecureStore.deleteItemAsync as jest.MockedFunction<typeof SecureStore.deleteItemAsync>;
const mockRefresh = refreshAccessToken as jest.MockedFunction<typeof refreshAccessToken>;

const STORED_TOKENS: SpotifyTokens = {
  access_token: 'access-abc',
  refresh_token: 'refresh-xyz',
  expires_at: Date.now() + 3_600_000,
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// loadStoredTokens()
// ---------------------------------------------------------------------------

describe('loadStoredTokens()', () => {
  it('returns null when nothing is stored', async () => {
    mockGetItem.mockResolvedValueOnce(null);

    expect(await loadStoredTokens()).toBeNull();
    expect(mockGetItem).toHaveBeenCalledTimes(1);
  });

  it('parses and returns stored tokens', async () => {
    mockGetItem.mockResolvedValueOnce(JSON.stringify(STORED_TOKENS));

    const tokens = await loadStoredTokens();

    expect(tokens).toEqual(STORED_TOKENS);
  });

  it('returns null when stored value is invalid JSON', async () => {
    mockGetItem.mockResolvedValueOnce('not-valid-json{{{');

    expect(await loadStoredTokens()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// saveTokens()
// ---------------------------------------------------------------------------

describe('saveTokens()', () => {
  it('serializes tokens and writes to SecureStore', async () => {
    mockSetItem.mockResolvedValueOnce();

    await saveTokens(STORED_TOKENS);

    expect(mockSetItem).toHaveBeenCalledTimes(1);
    const [, value] = mockSetItem.mock.calls[0];
    expect(JSON.parse(value)).toEqual(STORED_TOKENS);
  });
});

// ---------------------------------------------------------------------------
// clearTokens()
// ---------------------------------------------------------------------------

describe('clearTokens()', () => {
  it('calls SecureStore.deleteItemAsync', async () => {
    mockDeleteItem.mockResolvedValueOnce();

    await clearTokens();

    expect(mockDeleteItem).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// getValidToken()
// ---------------------------------------------------------------------------

describe('getValidToken()', () => {
  it('returns null when no tokens are stored', async () => {
    mockGetItem.mockResolvedValueOnce(null);

    expect(await getValidToken('cid', 'csecret')).toBeNull();
  });

  it('returns access_token directly when not yet expired', async () => {
    const fresh: SpotifyTokens = { ...STORED_TOKENS, expires_at: Date.now() + 120_000 };
    mockGetItem.mockResolvedValueOnce(JSON.stringify(fresh));

    const token = await getValidToken('cid', 'csecret');

    expect(token).toBe(fresh.access_token);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('refreshes and returns new access_token when expired', async () => {
    const expired: SpotifyTokens = { ...STORED_TOKENS, expires_at: Date.now() - 1 };
    const refreshed: SpotifyTokens = {
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_at: Date.now() + 3_600_000,
    };
    mockGetItem.mockResolvedValueOnce(JSON.stringify(expired));
    mockRefresh.mockResolvedValueOnce(refreshed);
    mockSetItem.mockResolvedValueOnce();

    const token = await getValidToken('cid', 'csecret');

    expect(token).toBe('new-access');
    expect(mockRefresh).toHaveBeenCalledWith('cid', 'csecret', expired.refresh_token);
    expect(mockSetItem).toHaveBeenCalledTimes(1);
  });

  it('returns null when the refresh call fails', async () => {
    const expired: SpotifyTokens = { ...STORED_TOKENS, expires_at: Date.now() - 1 };
    mockGetItem.mockResolvedValueOnce(JSON.stringify(expired));
    mockRefresh.mockRejectedValueOnce(new Error('401 Unauthorized'));

    expect(await getValidToken('cid', 'csecret')).toBeNull();
  });
});
