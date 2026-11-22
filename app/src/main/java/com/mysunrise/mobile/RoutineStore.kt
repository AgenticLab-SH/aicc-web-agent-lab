package com.mysunrise.mobile

import android.content.Context
import androidx.core.content.edit
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.time.LocalTime

internal class RoutineStore(context: Context) {
    private val preferences = context.getSharedPreferences("morning_routines", Context.MODE_PRIVATE)

    fun read(): List<Routine> = decodeRoutines(preferences.getString("routines", "[]") ?: "[]")

    fun write(routines: List<Routine>) {
        preferences.edit { putString("routines", encodeRoutines(routines)) }
    }
}

internal fun decodeRoutines(json: String): List<Routine> {
    val entries = JSONArray(json)
    return List(entries.length()) { index ->
        val item = entries.getJSONObject(index)
        val dates = if (item.has("completedDates")) {
            val saved = item.getJSONArray("completedDates")
            List(saved.length()) { LocalDate.parse(saved.getString(it)) }.toSet()
        } else {
            item.optString("completedOn").takeIf(String::isNotEmpty)
                ?.let { setOf(LocalDate.parse(it)) }.orEmpty()
        }
        Routine(
            id = item.getString("id"),
            title = item.getString("title"),
            start = LocalTime.parse(if (item.has("start")) item.getString("start") else item.getString("time")),
            end = if (item.isNull("end")) null else LocalTime.parse(item.getString("end")),
            completedDates = dates,
        )
    }
}

internal fun encodeRoutines(routines: List<Routine>): String {
    val entries = JSONArray()
    routines.forEach { routine ->
        val dates = JSONArray()
        routine.completedDates.sorted().forEach { dates.put(it.toString()) }
        entries.put(JSONObject()
            .put("id", routine.id)
            .put("title", routine.title)
            .put("start", routine.start.format(routineTimeFormat))
            .put("end", routine.end?.format(routineTimeFormat) ?: JSONObject.NULL)
            .put("completedDates", dates))
    }
    return entries.toString()
}
