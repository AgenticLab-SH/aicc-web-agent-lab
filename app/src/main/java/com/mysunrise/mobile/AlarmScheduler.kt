package com.mysunrise.mobile

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

/** Keep wake-up sound scheduling independent of the bulb network. */
object AlarmScheduler {
    const val ACTION_SUNRISE = "com.mysunrise.mobile.START_SUNRISE"
    const val ACTION_RING = "com.mysunrise.mobile.RING"
    private const val FLAGS = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

    private fun alarm(context: Context): AlarmManager =
        context.getSystemService(Context.ALARM_SERVICE) as AlarmManager

    private fun event(context: Context, code: Int, action: String): PendingIntent =
        PendingIntent.getBroadcast(
            context, code, Intent(context, AlarmReceiver::class.java).setAction(action), FLAGS
        )

    fun canSchedule(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarm(context).canScheduleExactAlarms()

    fun cancel(context: Context) {
        alarm(context).cancel(event(context, 101, ACTION_SUNRISE))
        alarm(context).cancel(event(context, 102, ACTION_RING))
    }

    fun nextWakeMillis(config: SunriseConfig, nowMillis: Long = System.currentTimeMillis()): Long {
        val zone = ZoneId.systemDefault()
        val wakeClock = LocalTime.of(config.hour, config.minute)
        val today = LocalDate.now(zone)
        for (offset in 0..8) {
            val day = today.plusDays(offset.toLong())
            if (config.weekdaysOnly &&
                (day.dayOfWeek == DayOfWeek.SATURDAY || day.dayOfWeek == DayOfWeek.SUNDAY)
            ) continue
            val wake = day.atTime(wakeClock).atZone(zone).toInstant().toEpochMilli()
            if (wake > nowMillis) return wake
        }
        error("다음 기상 시각을 계산할 수 없습니다.")
    }

    /**
     * Exact permission must be approved by the person using the phone.
     * Returns next sound-alarm epoch, or null if disabled.
     */
    fun schedule(context: Context): Long? {
        cancel(context)
        val config = ConfigStore.load(context)
        if (!config.enabled) return null
        check(canSchedule(context)) { "알람 및 리마인더 권한이 필요합니다." }
        val wake = nextWakeMillis(config)
        val start = wake - config.durationMinutes * 60_000L
        val manager = alarm(context)
        if (start > System.currentTimeMillis()) {
            manager.setExactAndAllowWhileIdle(
                AlarmManager.RTC_WAKEUP, start, event(context, 101, ACTION_SUNRISE)
            )
        }
        val openApp = PendingIntent.getActivity(
            context, 103,
            Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            FLAGS,
        )
        manager.setAlarmClock(
            AlarmManager.AlarmClockInfo(wake, openApp),
            event(context, 102, ACTION_RING),
        )
        return wake
    }
}
