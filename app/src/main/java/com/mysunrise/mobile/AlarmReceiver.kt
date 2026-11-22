package com.mysunrise.mobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

class AlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (!ConfigStore.load(context).enabled) return
        val serviceAction = when (intent.action) {
            AlarmScheduler.ACTION_SUNRISE -> SunriseService.START
            AlarmScheduler.ACTION_RING -> SunriseService.RING
            else -> return
        }
        val serviceIntent = Intent(context, SunriseService::class.java).setAction(serviceAction)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent)
            } else {
                context.startService(serviceIntent)
            }
        } catch (_: Exception) {
            // Android may reject background service creation. Do not block next alarm.
        }
        if (intent.action == AlarmScheduler.ACTION_RING) {
            try { AlarmScheduler.schedule(context) } catch (_: Exception) {
                // The next-day permission/error state is handled in the app UI.
            }
        }
    }
}
