import { requireOptionalNativeModule } from 'expo';
import { AppRegistry, PermissionsAndroid } from 'react-native';

export interface TickSubscription {
  remove(): void;
}

interface NativeForegroundService {
  startService(title: string, body: string, tickIntervalMs: number): void;
  updateService(body: string): void;
  stopService(): void;
  addListener(event: 'onTick', listener: () => void): TickSubscription;
}

// Keeps React Native's timer machinery alive while the app is backgrounded.
//
// JavaTimerManager.onHostPause() removes the choreographer callback that drives
// setTimeout/setInterval, and only restores it while a headless JS task is
// active. Without one, every JS timer in the app stops the moment the screen
// goes off — including the AbortController timeouts in owlet.ts, which would
// leave a hung request to block the poll loop forever.
//
// The task resolves only when the routine stops, which is also what lets the
// native service shut itself down (React Native stops a headless service once
// its last task finishes).
const KEEP_ALIVE_TASK = 'BabuRoutineKeepAlive';

let finishKeepAlive: (() => void) | null = null;

try {
  AppRegistry.registerHeadlessTask?.(KEEP_ALIVE_TASK, () => async () => {
    await new Promise<void>((resolve) => {
      finishKeepAlive = resolve;
    });
    finishKeepAlive = null;
  });
} catch {
  // Not every platform (or the Jest environment) has a headless task registry.
}

// Android keeps a process with a running foreground service alive and out of
// Doze, which is what lets the routine's polling loop survive the app being
// backgrounded or the screen going off. The local module in
// `modules/foreground-service` provides it.
//
// requireOptionalNativeModule returns null wherever that module is not part of
// the build — iOS, web, and the Jest environment — so every export below has to
// degrade to a no-op instead of throwing. The routine still works without it; it
// just stops when the OS decides to freeze the app.
function nativeService(): NativeForegroundService | null {
  return requireOptionalNativeModule<NativeForegroundService>('ForegroundService');
}

// POST_NOTIFICATIONS (Android 13+) governs whether the ongoing notification is
// *visible*, not whether the service may run, so a denial is never fatal and a
// failure to even ask (no activity attached, non-Android platform) is ignored.
async function requestNotificationPermission(): Promise<void> {
  try {
    const request = (PermissionsAndroid as { request?: (p: string) => Promise<string> }).request;
    const permission = PermissionsAndroid?.PERMISSIONS?.POST_NOTIFICATIONS;
    if (typeof request === 'function' && permission) {
      await request(permission);
    }
  } catch {
    // Ignored on purpose — see above.
  }
}

/**
 * Starts the ongoing foreground service. Returns whether it is actually running,
 * so the caller can tell the difference between "protected from the OS" and
 * "running only while the app is on screen".
 */
export async function startForegroundService(
  title: string,
  body: string,
  tickIntervalMs: number,
): Promise<boolean> {
  const service = nativeService();
  if (!service) return false;

  await requestNotificationPermission();

  try {
    service.startService(title, body, tickIntervalMs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Subscribes to the service's tick stream — a native `Handler` loop that runs on
 * the main looper under the service's wake lock, so it keeps firing with the
 * screen off. Returns null where there is no native service, leaving the caller
 * to fall back to a JS interval.
 */
export function addTickListener(listener: () => void): TickSubscription | null {
  try {
    return nativeService()?.addListener('onTick', listener) ?? null;
  } catch {
    return null;
  }
}

/** Updates the ongoing notification's text. Never throws. */
export function updateForegroundService(body: string): void {
  try {
    nativeService()?.updateService(body);
  } catch {
    // A notification that fails to update must not take the routine down.
  }
}

/** Stops the service and clears its notification. Never throws. */
export function stopForegroundService(): void {
  try {
    // Finish the keep-alive task first: React Native stops a headless service
    // once its last task finishes, and leaving the task pending would keep the
    // timer callback posted for the rest of the app's life.
    finishKeepAlive?.();
    finishKeepAlive = null;
  } catch {
    // Ignored — the stopService call below is the backstop.
  }
  try {
    nativeService()?.stopService();
  } catch {
    // Nothing useful to do — the service is either gone or will be reaped.
  }
}
