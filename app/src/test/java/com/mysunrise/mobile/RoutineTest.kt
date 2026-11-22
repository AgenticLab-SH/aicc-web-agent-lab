package com.mysunrise.mobile

import androidx.compose.ui.geometry.Offset
import org.junit.Assert.*
import org.junit.Test
import java.time.LocalDate
import java.time.LocalTime

class RoutineTest {
    @Test fun legacyStartAndCompletionSurviveTheFirstWrite() {
        val original = """[{"id":"existing-1","title":"물 한 잔","time":"07:10","completedOn":"2026-11-21"}]"""
        val legacy = decodeRoutines(original).single()
        assertEquals("existing-1", legacy.id)
        assertEquals("물 한 잔", legacy.title)
        assertEquals(LocalTime.of(7, 10), legacy.start)
        assertNull(legacy.end)
        assertEquals(setOf(LocalDate.of(2026, 11, 21)), legacy.completedDates)
        assertEquals(legacy, decodeRoutines(encodeRoutines(listOf(legacy))).single())
    }

    @Test fun deletedLastRoutineStaysEmptyAfterReload() {
        assertEquals("[]", encodeRoutines(emptyList()))
        assertTrue(decodeRoutines("[]").isEmpty())
    }

    @Test fun completionFollowsLocalDateWithoutErasingEarlierDates() {
        val firstDay = LocalDate.of(2026, 11, 21)
        val secondDay = firstDay.plusDays(1)
        val first = routine("night", "23:30", "00:15").withCompletionToggled(firstDay)
        assertFalse(secondDay in first.completedDates)
        val saved = decodeRoutines(encodeRoutines(listOf(first.withCompletionToggled(secondDay)))).single()
        assertEquals(setOf(firstDay, secondDay), saved.completedDates)
        assertEquals(setOf(firstDay), saved.withCompletionToggled(secondDay).completedDates)
    }

    @Test fun overnightRoutineIsActiveAcrossMidnightUntilItsEnd() {
        val night = routine("night", "23:30", "00:15")
        assertEquals(45, night.durationMinutes)
        assertEquals("23:30 – 다음 날 00:15", night.timeLabel())
        assertFalse(night.isActiveAt(23 * 60 + 29))
        assertTrue(night.isActiveAt(23 * 60 + 30))
        assertTrue(night.isActiveAt(0))
        assertTrue(night.isActiveAt(14))
        assertFalse(night.isActiveAt(15))
    }

    @Test fun nextRoutineWrapsToTomorrowAndStartOnlyRoutineHasNoInventedDuration() {
        val first = routine("first", "07:00")
        val later = routine("later", "12:00", "12:40")
        assertNull(first.durationMinutes)
        assertTrue(first.isActiveAt(420))
        assertFalse(first.isActiveAt(421))
        assertEquals(later, nextRoutine(listOf(first, later), 420))
        assertEquals(first, nextRoutine(listOf(first, later), 720))
        assertNull(nextRoutine(emptyList(), 420))
    }

    @Test fun overlappingRoutinesUseSeparateTracksIncludingAcrossMidnight() {
        val schedules = listOf(
            routine("early", "00:00", "00:10"),
            routine("adjacent", "00:10", "00:15"),
            routine("second", "23:00", "00:10"),
            routine("third", "23:15", "00:10"),
            routine("fourth", "23:30", "00:10"),
        )
        assertEquals(listOf(0, 0, 1, 2, 3), clockSegments(schedules).map { it.track })
    }

    @Test fun clockHitUsesTheOvernightArcAndItsOwnTrack() {
        val early = ClockSegment(routine("early", "00:00", "00:15"), track = 0)
        val night = ClockSegment(routine("night", "23:30", "00:15"), track = 1)
        val geometry = ClockGeometry(diameter = 320f, trackCount = 2)
        val midnightOnInnerTrack = Offset(0f, -geometry.radius(1))
        assertEquals(0f, geometry.distanceTo(night, midnightOnInnerTrack), .01f)
        assertTrue(geometry.distanceTo(early, midnightOnInnerTrack) > 10f)
        assertTrue(geometry.distanceTo(night, Offset(geometry.radius(1), 0f)) > 24f)
    }

    @Test(expected = IllegalArgumentException::class)
    fun equalStartAndEndCannotBeTreatedAsAnAllDayRoutine() {
        routine("equal", "07:00", "07:00")
    }

    private fun routine(id: String, start: String, end: String? = null): Routine =
        Routine(id, id, LocalTime.parse(start), end?.let(LocalTime::parse))
}
