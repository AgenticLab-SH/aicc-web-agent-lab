package com.mysunrise.mobile

import java.time.LocalDate
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.util.Locale

internal const val MINUTES_PER_DAY = 24 * 60
internal val routineTimeFormat: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm", Locale.ROOT)

internal fun LocalTime.minuteOfDay(): Int = hour * 60 + minute

internal data class Routine(
    val id: String,
    val title: String,
    val start: LocalTime,
    val end: LocalTime? = null,
    val completedDates: Set<LocalDate> = emptySet(),
) {
    init {
        require(end != start) { "Start and end times must differ." }
    }

    val startMinute: Int get() = start.minuteOfDay()
    val crossesMidnight: Boolean get() = end?.let { it < start } ?: false
    val durationMinutes: Int? get() = end?.let {
        Math.floorMod(it.minuteOfDay() - startMinute, MINUTES_PER_DAY)
    }

    fun isActiveAt(minute: Int): Boolean =
        Math.floorMod(minute - startMinute, MINUTES_PER_DAY) < (durationMinutes ?: 1)

    fun withCompletionToggled(date: LocalDate): Routine = copy(
        completedDates = if (date in completedDates) completedDates - date else completedDates + date,
    )

    fun timeLabel(): String {
        val startLabel = start.format(routineTimeFormat)
        val endLabel = end?.format(routineTimeFormat) ?: return "$startLabel 시작"
        return if (crossesMidnight) "$startLabel – 다음 날 $endLabel" else "$startLabel – $endLabel"
    }
}

internal fun nextRoutine(routines: List<Routine>, minute: Int): Routine? =
    routines.firstOrNull { it.startMinute > minute } ?: routines.firstOrNull()

internal data class ClockSegment(val routine: Routine, val track: Int)

internal fun clockSegments(routines: List<Routine>): List<ClockSegment> {
    val tracks = mutableListOf<MutableList<IntRange>>()
    return routines.map { routine ->
        val finish = routine.startMinute + (routine.durationMinutes ?: 1)
        val occupied = listOf(routine.startMinute until minOf(finish, MINUTES_PER_DAY)) +
            if (finish > MINUTES_PER_DAY) listOf(0 until finish - MINUTES_PER_DAY) else emptyList()
        val available = tracks.indexOfFirst { reserved ->
            occupied.none { slot -> reserved.any { it.first <= slot.last && slot.first <= it.last } }
        }
        val track = if (available >= 0) available else tracks.size.also { tracks.add(mutableListOf()) }
        tracks[track].addAll(occupied)
        ClockSegment(routine, track)
    }
}
