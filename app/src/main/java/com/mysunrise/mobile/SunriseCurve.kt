package com.mysunrise.mobile

import kotlin.math.roundToInt

/** Pure logic: independent of WiZ, Android, wall clock, and device availability. */
object SunriseCurve {
    data class Step(val brightness: Int, val kelvin: Int)

    fun at(progress: Double, maxBrightness: Int): Step {
        val t = progress.coerceIn(0.0, 1.0)
        val eased = t * t * (3 - 2 * t)
        return Step(
            brightness = (1 + (maxBrightness.coerceIn(10, 100) - 1) * eased)
                .roundToInt().coerceIn(1, 100),
            kelvin = (2200 + 1800 * eased).roundToInt().coerceIn(2200, 4000),
        )
    }
}
