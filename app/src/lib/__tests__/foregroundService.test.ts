import { PermissionsAndroid } from 'react-native';

jest.mock('expo', () => ({ requireOptionalNativeModule: jest.fn() }));

const { requireOptionalNativeModule } = require('expo') as {
  requireOptionalNativeModule: jest.Mock;
};

import {
  startForegroundService,
  updateForegroundService,
  stopForegroundService,
  addTickListener,
} from '../foregroundService';

function makeNative() {
  return {
    startService: jest.fn(),
    updateService: jest.fn(),
    stopService: jest.fn(),
    addListener: jest.fn(),
  };
}

beforeEach(() => {
  jest.resetAllMocks();
});

// ---------------------------------------------------------------------------
// Absent native module — iOS, web, Expo Go and the Jest environment all resolve
// the module to null. Every entry point must degrade to a silent no-op: the
// routine has to keep running even where no foreground service exists.
// ---------------------------------------------------------------------------

it('start/update/stop are no-ops when the native module is not in the build', async () => {
  requireOptionalNativeModule.mockReturnValue(null);

  await expect(startForegroundService('Babu', 'monitoring', 5000)).resolves.toBe(false);
  expect(() => updateForegroundService('120 BPM')).not.toThrow();
  expect(() => stopForegroundService()).not.toThrow();
});

// ---------------------------------------------------------------------------
// Present native module — delegate.
// ---------------------------------------------------------------------------

it('starts, updates and stops the native service when it is available', async () => {
  const nativeModule = makeNative();
  requireOptionalNativeModule.mockReturnValue(nativeModule);

  await expect(startForegroundService('Babu', 'monitoring', 5000)).resolves.toBe(true);
  expect(nativeModule.startService).toHaveBeenCalledWith('Babu', 'monitoring', 5000);

  updateForegroundService('118 BPM');
  expect(nativeModule.updateService).toHaveBeenCalledWith('118 BPM');

  stopForegroundService();
  expect(nativeModule.stopService).toHaveBeenCalled();
});

it('asks for POST_NOTIFICATIONS before starting the service', async () => {
  const nativeModule = makeNative();
  requireOptionalNativeModule.mockReturnValue(nativeModule);
  const request = jest.fn().mockResolvedValue('granted');
  (PermissionsAndroid as unknown as { request: unknown }).request = request;

  await startForegroundService('Babu', 'monitoring', 5000);

  expect(request).toHaveBeenCalledWith(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  expect(nativeModule.startService).toHaveBeenCalled();
});

it('still starts the service when the notification permission is denied', async () => {
  // POST_NOTIFICATIONS only controls whether the ongoing notification is
  // visible. The service — and therefore the routine — runs either way, so a
  // denial must never block the start.
  const nativeModule = makeNative();
  requireOptionalNativeModule.mockReturnValue(nativeModule);
  (PermissionsAndroid as unknown as { request: unknown }).request = jest
    .fn()
    .mockResolvedValue('denied');

  await expect(startForegroundService('Babu', 'monitoring', 5000)).resolves.toBe(true);
  expect(nativeModule.startService).toHaveBeenCalled();
});

it('still starts the service when the permission request itself throws', async () => {
  const nativeModule = makeNative();
  requireOptionalNativeModule.mockReturnValue(nativeModule);
  (PermissionsAndroid as unknown as { request: unknown }).request = jest
    .fn()
    .mockRejectedValue(new Error('no activity'));

  await expect(startForegroundService('Babu', 'monitoring', 5000)).resolves.toBe(true);
  expect(nativeModule.startService).toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// A misbehaving service must never take the routine down with it: the whole
// point of the service is to keep the routine alive.
// ---------------------------------------------------------------------------

it('swallows native errors instead of propagating them to the routine', async () => {
  const nativeModule = makeNative();
  nativeModule.startService.mockImplementation(() => {
    throw new Error('service refused to start');
  });
  nativeModule.updateService.mockImplementation(() => {
    throw new Error('notification update failed');
  });
  nativeModule.stopService.mockImplementation(() => {
    throw new Error('stop failed');
  });
  requireOptionalNativeModule.mockReturnValue(nativeModule);

  await expect(startForegroundService('Babu', 'monitoring', 5000)).resolves.toBe(false);
  expect(() => updateForegroundService('118 BPM')).not.toThrow();
  expect(() => stopForegroundService()).not.toThrow();
});

// ---------------------------------------------------------------------------
// Tick stream — the loop the routine actually runs on when the service exists.
// ---------------------------------------------------------------------------

it('returns null from addTickListener when there is no native service', () => {
  requireOptionalNativeModule.mockReturnValue(null);

  expect(addTickListener(jest.fn())).toBeNull();
});

it('subscribes to the native onTick event when the service is available', () => {
  const nativeModule = makeNative();
  const subscription = { remove: jest.fn() };
  nativeModule.addListener.mockReturnValue(subscription);
  requireOptionalNativeModule.mockReturnValue(nativeModule);

  const listener = jest.fn();
  expect(addTickListener(listener)).toBe(subscription);
  expect(nativeModule.addListener).toHaveBeenCalledWith('onTick', listener);
});

it('returns null instead of throwing when subscribing fails', () => {
  const nativeModule = makeNative();
  nativeModule.addListener.mockImplementation(() => {
    throw new Error('no emitter');
  });
  requireOptionalNativeModule.mockReturnValue(nativeModule);

  expect(addTickListener(jest.fn())).toBeNull();
});
