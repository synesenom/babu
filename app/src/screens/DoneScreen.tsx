import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { sharedStyles } from '../lib/theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Done'>;

export default function DoneScreen({ navigation }: Props) {
  function handleStartAgain() {
    navigation.reset({ index: 0, routes: [{ name: 'Setup' }] });
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        <Text style={styles.moon}>🌙</Text>
        <Text style={styles.heading}>Your baby is asleep</Text>
        <Text style={styles.subtext}>White noise is playing</Text>
        <TouchableOpacity style={styles.button} onPress={handleStartAgain}>
          <Text style={styles.buttonText}>Start again</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: sharedStyles.safe,
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  moon: {
    fontSize: 80,
    marginBottom: 24,
  },
  heading: {
    color: '#c9d1d9',
    fontSize: 28,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 12,
  },
  subtext: {
    color: '#8b949e',
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 48,
  },
  button: {
    backgroundColor: '#238636',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#2ea043',
    paddingHorizontal: 40,
    paddingVertical: 16,
    alignItems: 'center',
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '700',
  },
});
