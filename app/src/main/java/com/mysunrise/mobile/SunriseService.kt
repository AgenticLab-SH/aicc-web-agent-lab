package com.mysunrise.mobile

import android.app.*
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import kotlinx.coroutines.*

class SunriseService : Service() {
    companion object {
        const val START = "com.mysunrise.mobile.SERVICE_START"
        const val PREVIEW = "com.mysunrise.mobile.SERVICE_PREVIEW"
        const val RING = "com.mysunrise.mobile.SERVICE_RING"
        const val STOP = "com.mysunrise.mobile.SERVICE_STOP"
        private const val CHANNEL_RAMP = "sunrise_progress"
        private const val CHANNEL_ALARM = "sunrise_alarm"
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var rampJob: Job? = null
    private var player: MediaPlayer? = null
    private var lock: PowerManager.WakeLock? = null
    private var ringing = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val mgr = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        mgr.createNotificationChannel(NotificationChannel(
            CHANNEL_RAMP, "일출 진행", NotificationManager.IMPORTANCE_LOW
        ))
        mgr.createNotificationChannel(NotificationChannel(
            CHANNEL_ALARM, "기상 알람", NotificationManager.IMPORTANCE_HIGH
        ).apply { setSound(null, null) })
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            START, PREVIEW -> {
                val test = intent.action == PREVIEW
                showForeground(false)
                rampJob?.cancel()
                rampJob = scope.launch { ramp(if (test) 45 else ConfigStore.load(this@SunriseService).durationMinutes * 60) }
            }
            RING -> {
                ringing = true
                rampJob?.cancel()
                showForeground(true)
                startSound()
            }
            STOP -> stopSelf()
            else -> stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun showForeground(isAlarm: Boolean) {
        val open = PendingIntent.getActivity(
            this, if (isAlarm) 302 else 301,
            Intent(this, if (isAlarm) RingActivity::class.java else MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this, 303, Intent(this, SunriseService::class.java).setAction(STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = Notification.Builder(
            this, if (isAlarm) CHANNEL_ALARM else CHANNEL_RAMP
        )
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentTitle(if (isAlarm) "일어날 시간입니다" else "인공 일출 진행 중")
            .setContentText(if (isAlarm) "눌러서 알람을 끄세요." else "WiZ 조명이 밝아지고 있습니다.")
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(
                android.R.drawable.ic_delete, "중지", stop
            ).build())
            .setCategory(if (isAlarm) Notification.CATEGORY_ALARM else Notification.CATEGORY_SERVICE)
            .apply { if (isAlarm) setFullScreenIntent(open, true) }
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                if (isAlarm) 312 else 311,
                notification,
                if (isAlarm) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                else ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
            )
        } else {
            startForeground(if (isAlarm) 312 else 311, notification)
        }
        if (isAlarm) {
            (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).cancel(311)
        }
    }

    private suspend fun ramp(seconds: Int) {
        val config = ConfigStore.load(this)
        if (config.bulbIp.isBlank()) { stopSelf(); return }
        val power = getSystemService(POWER_SERVICE) as PowerManager
        val wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MySunrise:LightRamp").also {
            it.acquire((seconds + 30).toLong() * 1000L)
        }
        lock = wakeLock
        val started = SystemClock.elapsedRealtime()
        try {
            while (true) {
                val elapsed = (SystemClock.elapsedRealtime() - started).coerceAtLeast(0L)
                val fraction = (elapsed.toDouble() / (seconds * 1000.0)).coerceIn(0.0, 1.0)
                val step = SunriseCurve.at(fraction, config.maxBrightness)
                try { WizClient.setLight(config.bulbIp, true, step.brightness, step.kelvin) }
                catch (_: Exception) { /* next step may reconnect; audible alarm is separate */ }
                if (fraction >= 1.0) break
                delay(30_000L.coerceAtMost((seconds * 1000L - elapsed).coerceAtLeast(1L)))
            }
        } finally {
            try { if (wakeLock.isHeld) wakeLock.release() } catch (_: Exception) {}
            if (lock === wakeLock) lock = null
            if (!ringing) stopSelf()
        }
    }

    private fun startSound() {
        try {
            val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
                ?: android.provider.Settings.System.DEFAULT_ALARM_ALERT_URI
            player?.release()
            player = MediaPlayer().apply {
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
                )
                setDataSource(this@SunriseService, uri)
                isLooping = true
                prepare()
                start()
            }
        } catch (_: Exception) {
            // Don't silently claim the phone alarm is reliable until physical tests pass.
        }
        scope.launch {
            delay(10 * 60_000L)
            stopSelf()
        }
    }

    private fun releaseLock() {
        try { lock?.takeIf { it.isHeld }?.release() } catch (_: Exception) {}
        lock = null
    }

    override fun onDestroy() {
        rampJob?.cancel()
        scope.cancel()
        try { player?.stop() } catch (_: Exception) {}
        player?.release()
        player = null
        releaseLock()
        super.onDestroy()
    }
}
