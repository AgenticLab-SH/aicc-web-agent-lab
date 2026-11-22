package com.mysunrise.mobile

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.content.Context
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import java.time.LocalDate
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.UUID

private val scheduleDateFormat = DateTimeFormatter.ofPattern("yyyy년 M월 d일", Locale.KOREAN)

internal fun pickScheduleDate(context: Context, initial: LocalDate, onPicked: (LocalDate) -> Unit) {
    DatePickerDialog(context, { _, year, month, day -> onPicked(LocalDate.of(year, month + 1, day)) },
        initial.year, initial.monthValue - 1, initial.dayOfMonth).show()
}

@Composable
internal fun DatedScheduleEditor(
    existing: DatedSchedule?,
    initialDate: LocalDate,
    saving: Boolean,
    saveFailed: Boolean,
    onClose: () -> Unit,
    onSave: (DatedSchedule) -> Unit,
) {
    val context = LocalContext.current
    val id = rememberSaveable { existing?.id ?: UUID.randomUUID().toString() }
    var title by rememberSaveable { mutableStateOf(existing?.title.orEmpty()) }
    var dateText by rememberSaveable { mutableStateOf((existing?.start?.toLocalDate() ?: initialDate).toString()) }
    var startText by rememberSaveable { mutableStateOf(existing?.start?.format(routineTimeFormat) ?: "07:00") }
    var endText by rememberSaveable { mutableStateOf(existing?.end?.format(routineTimeFormat) ?: "07:30") }
    var endPicked by rememberSaveable { mutableStateOf(existing != null) }
    var fixed by rememberSaveable { mutableStateOf(existing?.fixed ?: false) }
    val date = LocalDate.parse(dateText)
    val start = LocalTime.parse(startText)
    val end = LocalTime.parse(endText)

    fun pickTime(initial: LocalTime, onPicked: (LocalTime) -> Unit) {
        TimePickerDialog(context, { _, hour, minute -> onPicked(LocalTime.of(hour, minute)) },
            initial.hour, initial.minute, true).show()
    }

    AlertDialog(
        onDismissRequest = { if (!saving) onClose() },
        title = { Text(if (existing == null) "일정 추가" else "일정 상세") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(title, { title = it.take(80) }, enabled = !saving, label = { Text("일정 이름") },
                    maxLines = 3, modifier = Modifier.fillMaxWidth())
                OutlinedButton(enabled = !saving, onClick = {
                    pickScheduleDate(context, date) { dateText = it.toString() }
                }) { Text("시작 날짜 ${date.format(scheduleDateFormat)}") }
                OutlinedButton(enabled = !saving, onClick = {
                    pickTime(start) { picked ->
                        startText = picked.format(routineTimeFormat)
                        if (!endPicked) endText = picked.plusMinutes(30).format(routineTimeFormat)
                    }
                }) { Text("시작 시각 $startText") }
                OutlinedButton(enabled = !saving, onClick = {
                    pickTime(end) { picked ->
                        endText = picked.format(routineTimeFormat)
                        endPicked = true
                    }
                }) { Text("종료 시각 $endText") }
                when {
                    end == start -> Text("시작과 종료 시각을 다르게 정해 주세요.", color = MaterialTheme.colorScheme.error)
                    end < start -> Text("다음 날 ${endText}에 끝나요.")
                }
                Column(Modifier.selectableGroup()) {
                    listOf(false to "유연 일정", true to "고정 일정").forEach { (option, label) ->
                        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).selectable(
                            selected = fixed == option, enabled = !saving, role = Role.RadioButton,
                            onClick = { fixed = option },
                        ), verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(selected = fixed == option, onClick = null, enabled = !saving)
                            Spacer(Modifier.width(8.dp))
                            Text(label)
                        }
                    }
                }
                if (saveFailed) Text("일정을 저장하지 못했어요. 입력 내용은 남아 있어요. 다시 저장해 보세요.",
                    color = MaterialTheme.colorScheme.error)
            }
        },
        confirmButton = {
            TextButton(enabled = !saving && title.isNotBlank() && start != end, onClick = {
                onSave(DatedSchedule(id, title.trim(), date.atTime(start), datedScheduleEnd(date, start, end), fixed))
            }) { Text(if (saving) "저장 중…" else "저장") }
        },
        dismissButton = { TextButton(enabled = !saving, onClick = onClose) { Text("취소") } },
    )
}
