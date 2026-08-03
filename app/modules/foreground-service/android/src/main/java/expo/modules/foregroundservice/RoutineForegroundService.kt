package expo.modules.foregroundservice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * Keeps the Babu routine's polling loop alive while the app is backgrounded.
 *
 * Two separate things are needed for that, and the service does both:
 *
 *  - A foreground service, so Android keeps the process at foreground importance
 *    instead of freezing or reaping it (Doze, and OEM background killers) once
 *    the app leaves the screen.
 *  - A partial wake lock, so the CPU keeps running with the screen off. A
 *    foreground service alone does not prevent suspend, and a suspended CPU
 *    stops the tick loop.
 *
 * It is a [HeadlessJsTaskService] for a third reason: React Native removes the
 * choreographer callback behind every JS timer in `onHostPause`, and only keeps
 * it while a headless task is active. The task started here does nothing but
 * stay pending, which is enough to keep the app's own timers — notably the
 * request timeouts in owlet.ts — working while the app is off screen.
 */
class RoutineForegroundService : HeadlessJsTaskService() {
  private var wakeLock: PowerManager.WakeLock? = null
  private val handler = Handler(Looper.getMainLooper())
  private val selfStop = Runnable { stopSelf() }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_UPDATE) {
      // Only refresh the text: re-entering the foreground state is unnecessary,
      // and going through super would start a second keep-alive task.
      val body = intent.getStringExtra(EXTRA_BODY).orEmpty()
      notificationManager().notify(NOTIFICATION_ID, buildNotification(lastTitle, body))
      return START_NOT_STICKY
    }

    lastTitle = intent?.getStringExtra(EXTRA_TITLE) ?: DEFAULT_TITLE
    val body = intent?.getStringExtra(EXTRA_BODY).orEmpty()
    // Must happen within a few seconds of startForegroundService(), and before
    // anything that might throw.
    startInForeground(buildNotification(lastTitle, body))
    acquireWakeLock()
    scheduleSelfStop()

    super.onStartCommand(intent, flags, startId)

    // Deliberately not START_STICKY: if the process dies, the JS routine dies
    // with it, and a service restarted without it would only leave a notification
    // claiming to monitor a baby that nothing is monitoring.
    return START_NOT_STICKY
  }

  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
    if (intent?.action == ACTION_UPDATE) return null
    return HeadlessJsTaskConfig(
      KEEP_ALIVE_TASK,
      Arguments.createMap(),
      // No timeout: the task is meant to stay pending for the whole routine.
      0,
      // The routine is started from the Monitoring screen, so the app is on
      // screen at that moment and the task would otherwise be rejected.
      true,
    )
  }

  override fun onDestroy() {
    handler.removeCallbacks(selfStop)
    releaseWakeLock()
    stopForeground(STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }

  private fun startInForeground(notification: Notification) {
    createChannel()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun buildNotification(title: String, body: String): Notification {
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    val contentIntent = PendingIntent.getActivity(
      this,
      0,
      launchIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle(title)
      .setContentText(body)
      .setSmallIcon(applicationInfo.icon)
      .setContentIntent(contentIntent)
      .setOngoing(true)
      .setSilent(true)
      .setShowWhen(false)
      .setOnlyAlertOnce(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .build()
  }

  private fun createChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      CHANNEL_NAME,
      // LOW, never DEFAULT: this notification updates every few seconds next to a
      // sleeping baby and must never make a sound or vibrate.
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = "Shows the bedtime routine while it runs in the background"
      setShowBadge(false)
      enableVibration(false)
      setSound(null, null)
    }
    notificationManager().createNotificationChannel(channel)
  }

  private fun notificationManager(): NotificationManager =
    getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

  private fun acquireWakeLock() {
    if (wakeLock?.isHeld == true) return
    val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = powerManager
      .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG)
      .also { it.acquire(MAX_RUNTIME_MS) }
  }

  private fun releaseWakeLock() {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
  }

  /**
   * Android 15 caps a `dataSync` foreground service at six hours per day and
   * kills the app if it overruns. Stopping just under that keeps the failure
   * mode "the routine ended" instead of "the app crashed at 3am". A bedtime
   * routine finishes long before this; a monitor-only session may not.
   */
  private fun scheduleSelfStop() {
    handler.removeCallbacks(selfStop)
    handler.postDelayed(selfStop, MAX_RUNTIME_MS)
  }

  private var lastTitle: String = DEFAULT_TITLE

  companion object {
    const val ACTION_START = "expo.modules.foregroundservice.START"
    const val ACTION_UPDATE = "expo.modules.foregroundservice.UPDATE"
    const val EXTRA_TITLE = "title"
    const val EXTRA_BODY = "body"

    // Must match the key registered with AppRegistry.registerHeadlessTask in
    // src/lib/foregroundService.ts.
    private const val KEEP_ALIVE_TASK = "BabuRoutineKeepAlive"

    private const val NOTIFICATION_ID = 4711
    private const val CHANNEL_ID = "babu-routine"
    private const val CHANNEL_NAME = "Bedtime routine"
    private const val DEFAULT_TITLE = "Babu"
    private const val WAKE_LOCK_TAG = "babu:routine"
    private const val MAX_RUNTIME_MS = 5L * 60L * 60L * 1000L + 45L * 60L * 1000L // 5h45m
  }
}
