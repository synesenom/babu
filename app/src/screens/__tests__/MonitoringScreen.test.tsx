import React from 'react';
import { render } from '@testing-library/react-native';
import MonitoringScreen from '../MonitoringScreen';
import { useRoutine } from '../../hooks/useRoutine';
import { CHOPIN_PLAYLIST } from '../../lib/constants';
import type { RoutineState, SpotifyPlayback, OwletReading } from '../../lib/types';

jest.mock('../../hooks/useRoutine');

const mockUseRoutine = useRoutine as jest.Mock;

const READING: OwletReading = {
  heart_rate: 118,
  oxygen: 98,
  battery: 80,
  movement: 'still',
  sock_off: false,
  sock_connected: true,
  base_on: true,
  charging: false,
  dsn: 'AC1',
  timestamp: '2024-01-01 00:00:00',
  raw: {},
};

const PLAYBACK: SpotifyPlayback = {
  is_playing: true,
  track_id: 'chopin-a',
  context_uri: CHOPIN_PLAYLIST,
  track_name: 'Nocturne Op. 9 No. 2',
  artist_name: 'Chopin',
  album_name: 'Nocturnes',
  progress_ms: 60000,
  duration_ms: 270000,
  remaining_ms: 210000,
  remaining_seconds: 210,
  device_name: 'Bedroom speaker',
  device_id: 'speaker-1',
};

async function renderScreen(state: Partial<RoutineState>) {
  const navigation = { replace: jest.fn(), reset: jest.fn() };
  mockUseRoutine.mockReturnValue({
    state: {
      status: 'running',
      lastReading: READING,
      nowPlaying: null,
      waitingFor: null,
      error: null,
      ...state,
    },
    start: jest.fn(),
    stop: jest.fn(),
  });

  const route = {
    params: {
      owlet: {},
      tokens: {},
      deviceName: 'iphone',
      pollIntervalMs: 5000,
      monitorOnly: false,
    },
  };

  const view = await render(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <MonitoringScreen route={route as any} navigation={navigation as any} />,
  );
  return { navigation, view };
}

it('shows the track that is currently playing', async () => {
  const { view } = await renderScreen({ nowPlaying: PLAYBACK });

  expect(view.getByText('Nocturne Op. 9 No. 2')).toBeTruthy();
  expect(view.getByText('Chopin')).toBeTruthy();
});

it('says so plainly when Spotify reports nothing playing', async () => {
  const { view } = await renderScreen({ nowPlaying: null });

  expect(view.getByText(/nothing playing/i)).toBeTruthy();
});

it('renders the transitioning status so the wait is visible', async () => {
  const { view } = await renderScreen({ status: 'transitioning', nowPlaying: PLAYBACK });

  expect(view.getByTestId('status-text').props.children).toBe('transitioning');
});

it('names the nocturne it is waiting out while transitioning', async () => {
  const { view } = await renderScreen({
    status: 'transitioning',
    nowPlaying: PLAYBACK,
    waitingFor: 'Nocturne Op. 9 No. 2',
  });

  expect(view.getByText(/white noise after ["“]?Nocturne Op\. 9 No\. 2/i)).toBeTruthy();
});

it('does not claim to be waiting for a track while the baby is awake', async () => {
  const { view } = await renderScreen({ status: 'running', nowPlaying: PLAYBACK });

  expect(view.queryByText(/white noise after/i)).toBeNull();
});

it('navigates to the Done screen only once the routine reports done', async () => {
  const { navigation } = await renderScreen({ status: 'transitioning', nowPlaying: PLAYBACK });
  expect(navigation.replace).not.toHaveBeenCalled();
});

it('navigates to Done when the routine reports done', async () => {
  const { navigation } = await renderScreen({ status: 'done' });
  expect(navigation.replace).toHaveBeenCalledWith('Done');
});
