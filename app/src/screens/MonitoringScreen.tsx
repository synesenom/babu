import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  SafeAreaView,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { useRoutine } from '../hooks/useRoutine';
import type { RoutineStatus } from '../lib/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Monitoring'>;

const STATUS_COLORS: Record<RoutineStatus, string> = {
  idle: '#8b949e',
  running: '#388bfd',
  transitioning: '#e3b341',
  done: '#3fb950',
};

export default function MonitoringScreen({ route, navigation }: Props) {
  const { owlet, tokens, deviceName } = route.params;
  const { state, start, stop } = useRoutine(owlet, tokens, deviceName);
  const [errorDismissed, setErrorDismissed] = useState(false);

  useEffect(() => {
    start();
  }, []);

  useEffect(() => {
    if (state.status === 'done') {
      navigation.replace('Done');
    }
  }, [state.status]);

  useEffect(() => {
    setErrorDismissed(false);
  }, [state.error]);

  function handleStop() {
    stop();
    navigation.replace('Setup');
  }

  const { lastReading, nowPlaying, status, error } = state;
  const statusColor = STATUS_COLORS[status];

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={[styles.statusPill, { backgroundColor: statusColor + '33', borderColor: statusColor }]}>
          <Text style={[styles.statusText, { color: statusColor }]}>{status}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardLabel}>Vitals</Text>
          {lastReading?.sock_off && (
            <View style={styles.sockOffBanner}>
              <Text style={styles.sockOffText}>Sock is off</Text>
            </View>
          )}
          <View style={styles.vitalsRow}>
            <View style={styles.vitalItem}>
              <Text style={styles.hrValue}>
                {lastReading?.heart_rate != null ? lastReading.heart_rate : '--'}
              </Text>
              <Text style={styles.hrUnit}>BPM</Text>
            </View>
            <View style={styles.vitalItem}>
              <Text style={styles.o2Value}>
                {lastReading?.oxygen != null ? lastReading.oxygen : '--'}
              </Text>
              <Text style={styles.vitalUnit}>O₂%</Text>
            </View>
            <View style={styles.vitalItem}>
              <Text style={styles.battValue}>
                {lastReading?.battery != null ? lastReading.battery : '--'}
              </Text>
              <Text style={styles.vitalUnit}>Batt%</Text>
            </View>
          </View>
          {lastReading && (
            <Text style={styles.movement}>
              {lastReading.movement ?? 'unknown'}
            </Text>
          )}
        </View>

        {nowPlaying && (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Now Playing</Text>
            <Text style={styles.trackName}>{nowPlaying.track_name}</Text>
            <Text style={styles.artistName}>{nowPlaying.artist_name}</Text>
          </View>
        )}

        {error && !errorDismissed && (
          <TouchableOpacity style={styles.errorBanner} onPress={() => setErrorDismissed(true)}>
            <Text style={styles.errorText}>{error}</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity style={styles.stopButton} onPress={handleStop}>
          <Text style={styles.stopButtonText}>Stop</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#0d1117',
  },
  scroll: {
    padding: 24,
    paddingBottom: 48,
  },
  statusPill: {
    alignSelf: 'center',
    borderRadius: 20,
    borderWidth: 1,
    paddingHorizontal: 20,
    paddingVertical: 6,
    marginBottom: 24,
  },
  statusText: {
    fontSize: 14,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  card: {
    backgroundColor: '#161b22',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#30363d',
    padding: 16,
    marginBottom: 16,
  },
  cardLabel: {
    color: '#8b949e',
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 12,
  },
  sockOffBanner: {
    backgroundColor: '#3d2a00',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#e3b341',
    padding: 10,
    marginBottom: 12,
  },
  sockOffText: {
    color: '#e3b341',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  vitalsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginBottom: 8,
  },
  vitalItem: {
    alignItems: 'center',
  },
  hrValue: {
    color: '#f85149',
    fontSize: 48,
    fontWeight: '700',
  },
  hrUnit: {
    color: '#f85149',
    fontSize: 12,
    fontWeight: '600',
  },
  o2Value: {
    color: '#388bfd',
    fontSize: 48,
    fontWeight: '700',
  },
  battValue: {
    color: '#3fb950',
    fontSize: 48,
    fontWeight: '700',
  },
  vitalUnit: {
    color: '#8b949e',
    fontSize: 12,
    fontWeight: '600',
  },
  movement: {
    color: '#8b949e',
    fontSize: 13,
    textAlign: 'center',
    textTransform: 'capitalize',
  },
  trackName: {
    color: '#c9d1d9',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 4,
  },
  artistName: {
    color: '#8b949e',
    fontSize: 14,
  },
  errorBanner: {
    backgroundColor: '#3d1d1d',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#f85149',
    padding: 12,
    marginBottom: 16,
  },
  errorText: {
    color: '#f85149',
    fontSize: 14,
  },
  stopButton: {
    backgroundColor: '#21262d',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#30363d',
    padding: 18,
    alignItems: 'center',
    marginTop: 8,
  },
  stopButtonText: {
    color: '#c9d1d9',
    fontSize: 18,
    fontWeight: '700',
  },
});
