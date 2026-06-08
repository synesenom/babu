import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  ScrollView,
  SafeAreaView,
  KeyboardAvoidingView,
  Platform,
  Switch,
} from 'react-native';
import { Picker } from '@react-native-picker/picker';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { useSpotifyAuth, loadStoredTokens, saveTokens } from '../lib/spotifyAuth';
import { Owlet } from '../lib/owlet';
import type { OwletReading, OwletRegion, SpotifyTokens } from '../lib/types';
import { MOCK_TOKEN } from '../lib/constants';

type Props = NativeStackScreenProps<RootStackParamList, 'Setup'>;

const extra = Constants.expoConfig?.extra as {
  spotifyClientId?: string;
  spotifyClientSecret?: string;
  mockMode?: boolean;
} | undefined;

const CLIENT_ID = extra?.spotifyClientId ?? '';
const CLIENT_SECRET = extra?.spotifyClientSecret ?? '';
const MOCK_MODE = extra?.mockMode ?? false;

const MOCK_SPOTIFY_TOKENS: SpotifyTokens = {
  access_token: MOCK_TOKEN,
  refresh_token: 'mock-refresh',
  expires_at: Date.now() + 86_400_000,
};

export default function SetupScreen({ navigation }: Props) {
  const [email, setEmail] = useState(MOCK_MODE ? 'test@example.com' : '');
  const [password, setPassword] = useState(MOCK_MODE ? 'password' : '');
  const [region, setRegion] = useState<OwletRegion>('world');
  const [deviceName, setDeviceName] = useState('iphone');
  const [monitorOnly, setMonitorOnly] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [owletStatus, setOwletStatus] = useState<'idle' | 'checking' | 'ok' | 'error'>('idle');
  const [initialising, setInitialising] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [storedTokens, setStoredTokens] = useState<SpotifyTokens | null>(null);

  const { tokens, promptAsync, isLoading: authLoading } = useSpotifyAuth(CLIENT_ID, CLIENT_SECRET);

  useEffect(() => {
    (async () => {
      const stored = await loadStoredTokens();
      if (stored) setStoredTokens(stored);
      if (!MOCK_MODE) {
        const savedEmail = await SecureStore.getItemAsync('owlet_email');
        const savedPassword = await SecureStore.getItemAsync('owlet_password');
        const savedRegion = await SecureStore.getItemAsync('owlet_region');
        if (savedEmail) setEmail(savedEmail);
        if (savedPassword) setPassword(savedPassword);
        const effectiveRegion = (savedRegion as OwletRegion | null) ?? 'world';
        if (savedRegion) setRegion(effectiveRegion);
        if (savedEmail && savedPassword) {
          setOwletStatus('checking');
          try {
            await Owlet.create(savedEmail, savedPassword, effectiveRegion);
            setOwletStatus('ok');
          } catch (e: unknown) {
            setOwletStatus('error');
            setError(e instanceof Error ? e.message : String(e));
          }
        }
      }
    })();
  }, []);

  const effectiveTokens = tokens ?? storedTokens;
  const isConnected = effectiveTokens !== null;

  async function handleMockConnect() {
    await saveTokens(MOCK_SPOTIFY_TOKENS);
    setStoredTokens(MOCK_SPOTIFY_TOKENS);
  }

  async function checkOwlet() {
    if (MOCK_MODE || !email || !password) return;
    setOwletStatus('checking');
    setError(null);
    try {
      await Owlet.create(email, password, region);
      setOwletStatus('ok');
    } catch (e: unknown) {
      setOwletStatus('error');
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleStart() {
    if (!isConnected || !effectiveTokens) return;
    setError(null);
    setInitialising(true);
    try {
      if (MOCK_MODE) {
        let tickCount = 0;
        const mockOwlet = {
          read: async (): Promise<OwletReading> => {
            tickCount += 1;
            return {
              heart_rate: tickCount <= 2 ? 120 : 90,
              oxygen: 98,
              battery: 80,
              movement: 'still',
              sock_off: false,
              sock_connected: true,
              base_on: true,
              charging: false,
              dsn: 'mock-dsn',
              timestamp: new Date().toISOString(),
              raw: {},
            };
          },
        } as unknown as Owlet;
        navigation.navigate('Monitoring', {
          owlet: mockOwlet,
          tokens: MOCK_SPOTIFY_TOKENS,
          deviceName: 'mock',
          pollIntervalMs: 500,
          monitorOnly,
        });
      } else {
        await SecureStore.setItemAsync('owlet_email', email);
        await SecureStore.setItemAsync('owlet_password', password);
        await SecureStore.setItemAsync('owlet_region', region);
        const owlet = await Owlet.create(email, password, region);
        navigation.navigate('Monitoring', { owlet, tokens: effectiveTokens, deviceName, monitorOnly });
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setInitialising(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.flex}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>babu</Text>

          <View style={styles.sectionLabelRow}>
            <Text style={[styles.sectionLabel, { marginTop: 0, marginBottom: 0 }]}>Owlet</Text>
            <View style={[styles.statusDot, { backgroundColor: owletStatus === 'ok' ? '#3fb950' : owletStatus === 'error' ? '#f85149' : owletStatus === 'checking' ? '#e3b341' : '#8b949e' }]} />
          </View>
          <View style={styles.card}>
            <TextInput
              style={styles.input}
              placeholder="Email"
              placeholderTextColor="#8b949e"
              value={email}
              onChangeText={(v) => { setEmail(v); setOwletStatus('idle'); }}
              autoCapitalize="none"
              keyboardType="email-address"
            />
            <View style={styles.passwordRow}>
              <TextInput
                style={[styles.input, styles.passwordInput]}
                placeholder="Password"
                placeholderTextColor="#8b949e"
                value={password}
                onChangeText={(v) => { setPassword(v); setOwletStatus('idle'); }}
                onBlur={checkOwlet}
                secureTextEntry={!showPassword}
              />
              <TouchableOpacity style={styles.eyeButton} onPress={() => setShowPassword((v) => !v)}>
                <Text style={styles.eyeText}>{showPassword ? '🙈' : '👁'}</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.pickerWrapper}>
              <Picker
                selectedValue={region}
                onValueChange={(v) => setRegion(v as OwletRegion)}
                style={styles.picker}
                dropdownIconColor="#c9d1d9"
              >
                <Picker.Item label="World" value="world" color="#c9d1d9" />
                <Picker.Item label="Europe" value="europe" color="#c9d1d9" />
              </Picker>
            </View>
          </View>

          <Text style={styles.sectionLabel}>Spotify</Text>
          <View style={styles.card}>
            {isConnected ? (
              <View style={styles.connectedRow}>
                <View style={styles.connectedDot} />
                <Text style={styles.connectedText}>Connected</Text>
              </View>
            ) : (
              <TouchableOpacity
                testID="connect-spotify-button"
                accessibilityLabel="Connect Spotify"
                style={styles.button}
                onPress={MOCK_MODE ? handleMockConnect : promptAsync}
                disabled={authLoading}
              >
                {authLoading ? (
                  <ActivityIndicator color="#ffffff" />
                ) : (
                  <Text style={styles.buttonText}>Connect Spotify</Text>
                )}
              </TouchableOpacity>
            )}
          </View>

          <Text style={styles.sectionLabel}>Device</Text>
          <View style={styles.card}>
            <TextInput
              style={styles.input}
              placeholder="Spotify device name"
              placeholderTextColor="#8b949e"
              value={deviceName}
              onChangeText={setDeviceName}
              autoCapitalize="none"
            />
          </View>

          <Text style={styles.sectionLabel}>Options</Text>
          <View style={styles.card}>
            <View style={styles.switchRow}>
              <View>
                <Text style={styles.switchLabel}>Monitor only</Text>
                <Text style={styles.switchHint}>Watch vitals without triggering transition</Text>
              </View>
              <Switch
                testID="monitor-only-switch"
                value={monitorOnly}
                onValueChange={setMonitorOnly}
                trackColor={{ false: '#30363d', true: '#388bfd' }}
                thumbColor="#ffffff"
              />
            </View>
          </View>

          {error ? (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <TouchableOpacity
            testID="start-routine-button"
            accessibilityLabel="Start Routine"
            style={[styles.startButton, (!isConnected || initialising) && styles.startButtonDisabled]}
            onPress={handleStart}
            disabled={!isConnected || initialising}
          >
            {initialising ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text style={styles.startButtonText}>Start Routine</Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#0d1117',
  },
  flex: {
    flex: 1,
  },
  scroll: {
    padding: 24,
    paddingTop: 72,
    paddingBottom: 48,
  },
  title: {
    color: '#ffffff',
    fontSize: 40,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 36,
    letterSpacing: 2,
  },
  sectionLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    marginTop: 16,
  },
  sectionLabel: {
    color: '#8b949e',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 8,
    marginTop: 16,
    alignSelf: 'flex-start',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginLeft: 8,
  },
  card: {
    backgroundColor: '#161b22',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#30363d',
    overflow: 'hidden',
  },
  input: {
    color: '#c9d1d9',
    fontSize: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#30363d',
  },
  passwordRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#30363d',
  },
  passwordInput: {
    flex: 1,
    borderBottomWidth: 0,
  },
  eyeButton: {
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  eyeText: {
    fontSize: 16,
  },
  pickerWrapper: {
    borderBottomWidth: 0,
  },
  picker: {
    color: '#c9d1d9',
    backgroundColor: 'transparent',
  },
  connectedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
  },
  connectedDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#3fb950',
    marginRight: 8,
  },
  connectedText: {
    color: '#3fb950',
    fontSize: 16,
    fontWeight: '600',
  },
  button: {
    backgroundColor: '#1db954',
    borderRadius: 0,
    padding: 16,
    alignItems: 'center',
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  switchLabel: {
    color: '#c9d1d9',
    fontSize: 16,
  },
  switchHint: {
    color: '#8b949e',
    fontSize: 12,
    marginTop: 2,
  },
  errorBanner: {
    backgroundColor: '#3d1d1d',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#f85149',
    padding: 12,
    marginTop: 16,
  },
  errorText: {
    color: '#f85149',
    fontSize: 14,
  },
  startButton: {
    backgroundColor: '#f85149',
    borderRadius: 8,
    padding: 18,
    alignItems: 'center',
    marginTop: 32,
  },
  startButtonDisabled: {
    backgroundColor: '#3d1d1d',
  },
  startButtonText: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '700',
  },
});
