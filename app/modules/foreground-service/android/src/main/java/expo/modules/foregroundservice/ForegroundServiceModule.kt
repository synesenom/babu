package expo.modules.foregroundservice

import android.content.Intent
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ForegroundServiceModule : Module() {
  // The routine's clock. A JS setInterval is not usable here: React Native drops
  // the choreographer callback that drives JS timers whenever the activity is
  // paused. A main-looper Handler keeps running as long as the process lives and
  // the CPU is awake, both of which the service guarantees.
  private val handler = Handler(Looper.getMainLooper())
  private var tickIntervalMs = 0L

  private val ticker = object : Runnable {
    override fun run() {
      sendEvent(EVENT_TICK)
      if (tickIntervalMs > 0L) {
        handler.postDelayed(this, tickIntervalMs)
      }
    }
  }

  private fun startTicking(intervalMs: Long) {
    stopTicking()
    if (intervalMs <= 0L) return
    tickIntervalMs = intervalMs
    handler.postDelayed(ticker, intervalMs)
  }

  private fun stopTicking() {
    tickIntervalMs = 0L
    handler.removeCallbacks(ticker)
  }

  override fun definition() = ModuleDefinition {
    Name("ForegroundService")

    Events(EVENT_TICK)

    // Must be called while the app is on screen: since Android 12 a backgrounded
    // process may not start a foreground service. The routine starts it from the
    // Monitoring screen, which is in the foreground when the user taps Start.
    Function("startService") { title: String, body: String, tickIntervalMs: Int ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val intent = Intent(context, RoutineForegroundService::class.java).apply {
        action = RoutineForegroundService.ACTION_START
        putExtra(RoutineForegroundService.EXTRA_TITLE, title)
        putExtra(RoutineForegroundService.EXTRA_BODY, body)
      }
      ContextCompat.startForegroundService(context, intent)
      startTicking(tickIntervalMs.toLong())
    }

    Function("updateService") { body: String ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val intent = Intent(context, RoutineForegroundService::class.java).apply {
        action = RoutineForegroundService.ACTION_UPDATE
        putExtra(RoutineForegroundService.EXTRA_BODY, body)
      }
      ContextCompat.startForegroundService(context, intent)
    }

    Function("stopService") {
      stopTicking()
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      context.stopService(Intent(context, RoutineForegroundService::class.java))
    }

    // The JS context is going away; nothing left to tick for.
    OnDestroy { stopTicking() }
  }

  companion object {
    private const val EVENT_TICK = "onTick"
  }
}
