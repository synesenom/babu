import React from 'react';
import { StyleSheet, Text, TouchableOpacity, ViewStyle } from 'react-native';
import { colors } from '../lib/theme';

type Props = {
  message: string;
  onPress?: () => void;
  style?: ViewStyle;
};

export default function ErrorBanner({ message, onPress, style }: Props) {
  return (
    <TouchableOpacity
      style={[styles.banner, style]}
      onPress={onPress}
      disabled={!onPress}
      activeOpacity={onPress ? 0.7 : 1}
    >
      <Text style={styles.text}>{message}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: colors.dangerBackground,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.danger,
    padding: 12,
  },
  text: {
    color: colors.danger,
    fontSize: 14,
  },
});
