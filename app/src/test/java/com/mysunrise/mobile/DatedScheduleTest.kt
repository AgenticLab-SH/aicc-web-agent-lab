package com.mysunrise.mobile

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.nio.file.Files
import java.time.LocalDate
import java.time.LocalTime

class DatedScheduleTest {
    @get:Rule val files = TemporaryFolder()
    private val day = LocalDate.of(2026, 11, 22)

    @Test fun overnightScheduleReusesItsIdAndClipsEachDay() {
        val event = schedule("overnight", "23:30", "00:15")
        val first = checkNotNull(event.onDay(day))
        val second = checkNotNull(event.onDay(day.plusDays(1)))
        assertEquals(event.clockId, first.id)
        assertEquals(first.id, second.id)
        assertEquals(30, first.durationMinutes)
        assertEquals(15, second.durationMinutes)
        assertFalse(first.isActiveAt(0))
        assertTrue(second.isActiveAt(0))
        assertFalse(second.isActiveAt(15))
        assertEquals("23:30 – 다음 날 00:15", event.timeLabelOn(day))
        assertEquals("전날 23:30 – 00:15", event.timeLabelOn(day.plusDays(1)))
        assertNull(event.onDay(day.minusDays(1)))
        assertNull(event.onDay(day.plusDays(2)))
    }

    @Test fun midnightEndDoesNotCreateAnotherDayRow() {
        val event = schedule("midnight", "23:30", "00:00")
        assertEquals(30, event.onDay(day)?.durationMinutes)
        assertNull(event.onDay(day.plusDays(1)))
    }

    @Test(expected = IllegalArgumentException::class)
    fun equalTimesAreRejected() {
        schedule("invalid", "07:00", "07:00")
    }

    @Test fun reopeningReadsSavedDateTimesAndFixedValueWithoutDuplicatingTheId() {
        val path = files.root.toPath().resolve("dated-schedules-v1.json")
        val store = DatedScheduleStore(path)
        assertTrue(store.read().isEmpty())
        val original = schedule("first", "07:00", "08:00")
        store.save(original)
        assertEquals(listOf(original), DatedScheduleStore(path).read())

        val another = schedule("second", "11:00", "12:00")
        DatedScheduleStore(path).save(another)
        val updated = schedule(original.id, "23:30", "00:15").copy(fixed = true)
        store.save(updated)
        val saved = DatedScheduleStore(path).read()
        assertEquals(2, saved.size)
        assertEquals(mapOf(original.id to updated, another.id to another), saved.associateBy { it.id })
    }

    @Test fun corruptOrUnsupportedDataCannotBeReplacedByASave() {
        val path = files.root.toPath().resolve("dated-schedules-v1.json")
        for (original in listOf("{", """{"version":2,"schedules":[]}""")) {
            Files.write(path, original.toByteArray(Charsets.UTF_8))
            val result = runCatching { DatedScheduleStore(path).save(schedule("first", "07:00", "08:00")) }
            assertTrue(result.isFailure)
            assertArrayEquals(original.toByteArray(Charsets.UTF_8), Files.readAllBytes(path))
        }
    }

    private fun schedule(id: String, startText: String, endText: String): DatedSchedule {
        val start = LocalTime.parse(startText)
        val end = LocalTime.parse(endText)
        return DatedSchedule(id, "일정 $id", day.atTime(start), datedScheduleEnd(day, start, end), fixed = false)
    }
}
