package com.mysunrise.mobile

import android.content.Context
import java.io.Serializable

data class SunriseConfig(
    val bulbIp: String = "",
    val hour: Int = 7,
    val minute: Int = 0,
    val durationMinutes: Int = 30,
    val maxBrightness: Int = 80,
    val weekdaysOnly: Boolean = false,
    val enabled: Boolean = false,
) : Serializable

object ConfigStore {
    private const val STORE = "sunrise_settings"
    fun load(context: Context): SunriseConfig {
        val p = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
        return SunriseConfig(
            bulbIp = p.getString("bulbIp", "") ?: "",
            hour = p.getInt("hour", 7).coerceIn(0, 23),
            minute = p.getInt("minute", 0).coerceIn(0, 59),
            durationMinutes = p.getInt("duration", 30).coerceIn(5, 60),
            maxBrightness = p.getInt("brightness", 80).coerceIn(10, 100),
            weekdaysOnly = p.getBoolean("weekdaysOnly", false),
            enabled = p.getBoolean("enabled", false),
        )
    }
    fun save(context: Context, value: SunriseConfig) {
        context.getSharedPreferences(STORE, Context.MODE_PRIVATE).edit()
            .putString("bulbIp", value.bulbIp.trim())
            .putInt("hour", value.hour)
            .putInt("minute", value.minute)
            .putInt("duration", value.durationMinutes)
            .putInt("brightness", value.maxBrightness)
            .putBoolean("weekdaysOnly", value.weekdaysOnly)
            .putBoolean("enabled", value.enabled).apply()
    }
}
