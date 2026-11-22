package com.mysunrise.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SunriseCurveTest {
    @Test fun boundaries() {
        assertEquals(SunriseCurve.Step(1, 2200), SunriseCurve.at(0.0, 80))
        assertEquals(SunriseCurve.Step(80, 4000), SunriseCurve.at(1.0, 80))
    }
    @Test fun monotonic() {
        val steps = (0..100).map { SunriseCurve.at(it / 100.0, 80) }
        assertTrue(steps.zipWithNext().all { (a, b) ->
            a.brightness <= b.brightness && a.kelvin <= b.kelvin
        })
    }
    @Test fun clampsInput() {
        assertEquals(SunriseCurve.at(0.0, 80), SunriseCurve.at(-2.0, 80))
        assertEquals(SunriseCurve.at(1.0, 80), SunriseCurve.at(2.0, 80))
    }
}
