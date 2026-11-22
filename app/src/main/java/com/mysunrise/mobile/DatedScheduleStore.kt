package com.mysunrise.mobile

import org.json.JSONArray
import org.json.JSONObject
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import java.time.LocalDateTime

internal class DatedScheduleStore(private val file: Path) {
    fun read(): List<DatedSchedule> = synchronized(writeLock) { readFile() }

    fun save(schedule: DatedSchedule): List<DatedSchedule> = synchronized(writeLock) {
        val updated = readFile().filterNot { it.id == schedule.id } + schedule
        val rows = JSONArray()
        for (item in updated) {
            rows.put(JSONObject().put("id", item.id).put("title", item.title)
                .put("start", item.start.toString()).put("end", item.end.toString()).put("fixed", item.fixed))
        }
        val payload = JSONObject().put("version", 1).put("schedules", rows).toString()
        val temp = Files.createTempFile(file.parent, "schedule-", ".tmp")
        try {
            FileOutputStream(temp.toFile()).use { output ->
                output.write(payload.toByteArray(Charsets.UTF_8))
                output.fd.sync()
            }
            Files.move(temp, file, ATOMIC_MOVE, REPLACE_EXISTING)
        } finally {
            runCatching { Files.deleteIfExists(temp) }
        }
        updated
    }

    private fun readFile(): List<DatedSchedule> {
        if (Files.notExists(file)) return emptyList()
        val payload = JSONObject(String(Files.readAllBytes(file), Charsets.UTF_8))
        require(payload.getInt("version") == 1) { "Unsupported schedule file version" }
        val rows = payload.getJSONArray("schedules")
        val schedules = List(rows.length()) { index ->
            val row = rows.getJSONObject(index)
            DatedSchedule(row.getString("id"), row.getString("title"),
                LocalDateTime.parse(row.getString("start")), LocalDateTime.parse(row.getString("end")),
                row.getBoolean("fixed"))
        }
        require(schedules.distinctBy { it.id }.size == schedules.size) { "Duplicate schedule IDs" }
        return schedules
    }

    private companion object {
        val writeLock = Any()
    }
}
