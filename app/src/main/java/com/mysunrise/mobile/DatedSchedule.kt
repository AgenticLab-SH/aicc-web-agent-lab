package com.mysunrise.mobile

import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime

internal data class DatedSchedule(
    val id: String,
    val title: String,
    val start: LocalDateTime,
    val end: LocalDateTime,
    val fixed: Boolean,
) {
    init {
        require(id.isNotBlank() && title.isNotBlank())
        require(end.isAfter(start) && end.isBefore(start.plusDays(1)))
    }

    val clockId: String get() = "dated:$id"

    fun onDay(date: LocalDate): Routine? {
        val dayStart = date.atStartOfDay()
        val dayEnd = dayStart.plusDays(1)
        if (start >= dayEnd || end <= dayStart) return null
        // The clock already represents midnight as 00:00 and wraps the arc to that boundary.
        return Routine(clockId, title, maxOf(start, dayStart).toLocalTime(), minOf(end, dayEnd).toLocalTime())
    }

    fun timeLabelOn(date: LocalDate): String {
        val startDay = if (start.toLocalDate() < date) "전날 " else ""
        val endDay = if (end.toLocalDate() > date) "다음 날 " else ""
        return "$startDay${start.format(routineTimeFormat)} – $endDay${end.format(routineTimeFormat)}"
    }
}

internal fun datedScheduleEnd(date: LocalDate, start: LocalTime, end: LocalTime): LocalDateTime =
    date.plusDays(if (end < start) 1 else 0).atTime(end)
