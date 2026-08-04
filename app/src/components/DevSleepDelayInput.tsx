import React from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';

type Props = {
  value: string;
  onChangeText: (value: string) => void;
};

export default function DevSleepDelayInput({ value, onChangeText }: Props) {
  return (
    <View style={styles.row}>
      <View>
        <Text style={styles.label}>Sleep after (seconds)</Text>
        <Text style={styles.hint}>Dev mock: HR drops below threshold after this delay</Text>
      </View>
      <TextInput
        testID="dev-sleep-delay-input"
        style={styles.input}
        keyboardType="numeric"
        value={value}
        onChangeText={onChangeText}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  label: {
    color: '#c9d1d9',
    fontSize: 16,
  },
  hint: {
    color: '#8b949e',
    fontSize: 12,
    marginTop: 2,
  },
  input: {
    color: '#c9d1d9',
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#30363d',
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minWidth: 56,
    textAlign: 'center',
  },
});
