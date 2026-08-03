import { StyleSheet } from 'react-native';

export const colors = {
  background: '#0d1117',
  card: '#161b22',
  border: '#30363d',
  text: '#c9d1d9',
  muted: '#8b949e',
  danger: '#f85149',
  dangerBackground: '#3d1d1d',
  success: '#3fb950',
  warning: '#e3b341',
  accent: '#388bfd',
};

export const sharedStyles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.background,
  },
});
