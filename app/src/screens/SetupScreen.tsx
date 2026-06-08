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
} from 'react-native';
import { Picker } from '@react-native-picker/picker';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { useSpotifyAuth, loadStoredTokens } from '../lib/spotifyAuth';
import { Owlet } from '../lib/owlet';
import type { OwletRegion } from '../lib/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Setup'>;

const extra = Constants.expoConfig?.extra as {
  spotifyClientId?: string;
  spotifyClientSecret?: string;
} | undefined;

const CLIENT_ID = extra?.spotifyClientId ?? '';
const CLIENT_SECRET = extra?.spotifyClientSecret ?? '';

export default function SetupScreen({ navigation }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [region, setRegion] = useState<OwletRegion>('world');
  const [deviceName, setDeviceName] = useState('iphone');
  const [initialising, setInitialising] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { tokens, promptAsync, isLoading: authLoading } = useSpotifyAuth(CLIENT_ID, CLIENT_SECRET);

  useEffect(() => {
    (async () => {
      const stored = await loadStoredTokens();
      if (stored && !tokens) {
        // tokens already restored inside useSpotifyAuth on its own mount
      }
      const savedEmail = await SecureStore.getItemAsync('owlet_email');
      if (savedEmail) setEmail(savedEmail);
    })();
  }, []);

  const isConnected = tokens !== null;

  async function handleStart() {
    if (!isConnected || !tokens) return;
    setError(null);
    setInitialising(true);
    try {
      await SecureStore.setItemAsync('owlet_email', email);
      const owlet = await Owlet.create(email, password, region);
      navigation.navigate('Monitoring', { owlet, tokens, deviceName });
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

          <Text style={styles.sectionLabel}>Owlet</Text>
          <View style={styles.card}>
            <TextInput
              style={styles.input}
              placeholder="Email"
              placeholderTextColor="#8b949e"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
            />
            <TextInput
              style={styles.input}
              placeholder="Password"
              placeholderTextColor="#8b949e"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
            />
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
                style={styles.button}
                onPress={promptAsync}
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

          {error ? (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <TouchableOpacity
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
  sectionLabel: {
    color: '#8b949e',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 8,
    marginTop: 16,
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
