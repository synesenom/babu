import React from 'react';
import { Text, StyleSheet } from 'react-native';
import appJson from '../../app.json';

export default function VersionLabel() {
  return <Text style={styles.text}>v{appJson.expo.version}</Text>;
}

const styles = StyleSheet.create({
  text: {
    color: '#8b949e',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 16,
  },
});
