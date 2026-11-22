package com.mysunrise.mobile

import android.app.TimePickerDialog
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale
import java.util.UUID

private val routineDateFormat = DateTimeFormatter.ofPattern("M월 d일 EEEE", Locale.KOREAN)

@Composable
internal fun RoutineHome(sunrise: @Composable () -> Unit) {
    var showSunrise by rememberSaveable { mutableStateOf(false) }
    val screenState = rememberSaveableStateHolder()
    BackHandler(showSunrise) { showSunrise = false }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        bottomBar = {
            NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
                NavigationBarItem(selected = !showSunrise, onClick = { showSunrise = false },
                    icon = { Text("◷", style = MaterialTheme.typography.titleLarge) }, label = { Text("오늘") })
                NavigationBarItem(selected = showSunrise, onClick = { showSunrise = true },
                    icon = { Text("☀", style = MaterialTheme.typography.titleLarge) }, label = { Text("기상 설정") })
            }
        },
    ) { insets ->
        Box(Modifier.fillMaxSize().padding(insets), contentAlignment = Alignment.TopCenter) {
            screenState.SaveableStateProvider(if (showSunrise) "sunrise" else "today") {
                if (showSunrise) sunrise() else TodayRoutines()
            }
        }
    }
}

@Composable
private fun TodayRoutines() {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val store = remember(context) { RoutineStore(context) }
    val scheduleStore = remember(context) {
        DatedScheduleStore(context.filesDir.toPath().resolve("dated-schedules-v1.json"))
    }
    var routines by remember(store) { mutableStateOf(runCatching { store.read() }.getOrNull()) }
    var schedules by remember(scheduleStore) { mutableStateOf<List<DatedSchedule>?>(null) }
    var scheduleLoadFailed by remember { mutableStateOf(false) }
    var scheduleReload by remember { mutableIntStateOf(0) }
    var now by remember { mutableStateOf(routineNow()) }
    var editorId by rememberSaveable { mutableStateOf<String?>(null) }
    var scheduleEditorId by rememberSaveable { mutableStateOf<String?>(null) }
    var chosenDate by rememberSaveable { mutableStateOf<String?>(null) }
    var savingSchedule by remember { mutableStateOf(false) }
    var scheduleSaveFailed by remember { mutableStateOf(false) }
    var selectedId by rememberSaveable { mutableStateOf<String?>(null) }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()

    LaunchedEffect(scheduleStore, scheduleReload) {
        val result = withContext(Dispatchers.IO) { runCatching { scheduleStore.read() } }
        schedules = result.getOrNull()
        scheduleLoadFailed = result.isFailure
    }
    LaunchedEffect(Unit) {
        while (true) {
            now = routineNow()
            delay(60_000L - Math.floorMod(System.currentTimeMillis(), 60_000L))
        }
    }
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) now = routineNow()
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    val items = remember(routines) { routines.orEmpty().sortedBy { it.start } }
    val today = now.toLocalDate()
    val date = chosenDate?.let(LocalDate::parse) ?: today
    val showingToday = date == today
    val datedItems = remember(schedules, date) {
        schedules.orEmpty().mapNotNull { schedule -> schedule.onDay(date)?.let { it to schedule } }
    }
    val scheduleByClockId = remember(datedItems) { datedItems.associate { (entry, schedule) -> entry.id to schedule } }
    val timeline = remember(items, datedItems) { (items + datedItems.map { it.first }).sortedBy { it.start } }
    val minute = now.toLocalTime().minuteOfDay()
    val active = if (showingToday) items.filter { it.isActiveAt(minute) } else emptyList()
    val next = nextRoutine(items, minute)
    val completed = items.count { date in it.completedDates }

    fun save(updated: List<Routine>) {
        store.write(updated)
        routines = updated
    }

    fun openSchedule(id: String) {
        scheduleSaveFailed = false
        scheduleEditorId = id
    }

    LazyColumn(
        state = listState,
        modifier = Modifier.widthIn(max = 760.dp).fillMaxWidth().fillMaxHeight(),
        contentPadding = PaddingValues(horizontal = 18.dp, vertical = 24.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item(key = "today-heading", contentType = "header") {
            Column {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = {
                        pickScheduleDate(context, date) { picked ->
                            chosenDate = picked.takeUnless { it == routineNow().toLocalDate() }?.toString()
                        }
                    }, modifier = Modifier.weight(1f, fill = false)) { Text(routineDateFormat.format(date) + " 변경") }
                    if (!showingToday) TextButton(onClick = { chosenDate = null }) { Text("오늘로") }
                }
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(if (showingToday) "오늘의 계획" else "하루 계획", style = MaterialTheme.typography.headlineLarge,
                        modifier = Modifier.weight(1f).semantics { heading() })
                    TextButton(enabled = schedules != null, onClick = { openSchedule("") }) { Text("일정 추가") }
                }
            }
        }

        item(key = "progress") {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (scheduleLoadFailed) {
                    Text("저장된 일정을 열 수 없어요.", color = MaterialTheme.colorScheme.error)
                    OutlinedButton(onClick = {
                        scheduleLoadFailed = false
                        scheduleReload++
                    }) { Text("일정 다시 불러오기") }
                } else if (schedules == null) {
                    Text("일정을 불러오는 중이에요.", style = MaterialTheme.typography.bodyMedium)
                }
                if (routines == null) {
                    Text("저장된 루틴을 열 수 없어요.", color = MaterialTheme.colorScheme.error)
                    OutlinedButton(onClick = { routines = runCatching { store.read() }.getOrNull() }) {
                        Text("다시 불러오기")
                    }
                } else {
                    if (next != null) {
                        RoutineProgress(completed, items.size, active, next, minute, showingToday)
                        TextButton(onClick = { editorId = "" }) { Text("루틴 추가") }
                    } else {
                        if (schedules != null && timeline.isEmpty()) {
                            Text("이 날짜의 일정과 루틴이 비어 있어요.", style = MaterialTheme.typography.titleMedium)
                        }
                        TextButton(onClick = { editorId = "" }) { Text("첫 루틴 추가") }
                    }
                }
            }
        }
        if (timeline.isNotEmpty()) {
            item(key = "clock") {
                RoutineClock(timeline, date, now.takeIf { showingToday }, scheduleByClockId.isNotEmpty()) { id ->
                    val schedule = scheduleByClockId[id]
                    if (schedule != null) {
                        openSchedule(schedule.id)
                    } else {
                        val index = timeline.indexOfFirst { it.id == id }
                        if (index >= 0) {
                            selectedId = id
                            // The heading, progress, clock, and list heading precede the routine rows.
                            scope.launch { listState.animateScrollToItem(index + 4) }
                        }
                    }
                }
            }
            item(key = "list-heading") {
                Text("시간순 목록", style = MaterialTheme.typography.titleLarge,
                    modifier = Modifier.semantics { heading() })
            }
            items(timeline, key = { it.id }, contentType = { if (it.id in scheduleByClockId) "schedule" else "routine" }) { routine ->
                val schedule = scheduleByClockId[routine.id]
                if (schedule != null) {
                    DatedScheduleRow(schedule, date, showingToday && routine.isActiveAt(minute)) { openSchedule(schedule.id) }
                } else {
                    RoutineRow(
                        routine,
                        completed = date in routine.completedDates,
                        active = showingToday && routine.isActiveAt(minute),
                        selected = routine.id == selectedId,
                        canComplete = showingToday,
                        onToggle = {
                            now = routineNow()
                            val actionDate = now.toLocalDate()
                            save(items.map { item ->
                                if (item.id == routine.id) item.withCompletionToggled(actionDate) else item
                            })
                        },
                        onEdit = { editorId = routine.id },
                    )
                }
            }
        }
    }

    val scheduleId = scheduleEditorId
    if (schedules != null && scheduleId != null) {
        val existing = schedules?.firstOrNull { it.id == scheduleId }
        if (scheduleId.isEmpty() || existing != null) key(scheduleId) {
            DatedScheduleEditor(existing, date, savingSchedule, scheduleSaveFailed,
                onClose = { scheduleEditorId = null },
                onSave = { updated ->
                    if (!savingSchedule) {
                        savingSchedule = true
                        scheduleSaveFailed = false
                        scope.launch {
                            val result = withContext(Dispatchers.IO) { runCatching { scheduleStore.save(updated) } }
                            savingSchedule = false
                            result.onSuccess {
                                schedules = it
                                if (updated.onDay(date) == null) {
                                    chosenDate = updated.start.toLocalDate().takeUnless { day ->
                                        day == routineNow().toLocalDate()
                                    }?.toString()
                                }
                                scheduleEditorId = null
                            }.onFailure { scheduleSaveFailed = true }
                        }
                    }
                })
        }
    }

    val id = editorId
    if (routines != null && id != null) {
        val existing = items.firstOrNull { it.id == id }
        if (id.isEmpty() || existing != null) key(id) {
            RoutineEditor(existing, onClose = { editorId = null }, onSave = { updated ->
                val replacement = if (existing == null) items + updated else
                    items.map { if (it.id == updated.id) updated else it }
                save(replacement)
                editorId = null
            }, onDelete = {
                save(items.filterNot { it.id == id })
                if (selectedId == id) selectedId = null
                editorId = null
            })
        }
    }
}

private fun routineNow(): LocalDateTime = LocalDateTime.now().truncatedTo(ChronoUnit.MINUTES)

@Composable
private fun RoutineProgress(completed: Int, total: Int, active: List<Routine>, next: Routine, minute: Int, showingToday: Boolean) {
    Card(Modifier.fillMaxWidth(), shape = RoundedCornerShape(28.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(if (showingToday) "오늘의 리듬" else "그날의 루틴", style = MaterialTheme.typography.titleMedium)
            Text("$completed / $total 완료", style = MaterialTheme.typography.headlineSmall)
            LinearProgressIndicator(progress = { completed.toFloat() / total }, modifier = Modifier.fillMaxWidth())
            if (!showingToday) {
                Text("완료 체크는 오늘 화면에서 할 수 있어요.", style = MaterialTheme.typography.bodySmall)
                return@Column
            }
            val current = active.firstOrNull()
            if (current != null) {
                val additional = if (active.size > 1) " 외 ${active.size - 1}개" else ""
                Text("지금  ${current.title}$additional", style = MaterialTheme.typography.bodyMedium)
            }
            val nextDay = if (next.startMinute <= minute) "내일 " else ""
            Text("다음  $nextDay${next.start.format(routineTimeFormat)}  ${next.title}",
                style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun RoutineRow(
    routine: Routine,
    completed: Boolean,
    active: Boolean,
    selected: Boolean,
    canComplete: Boolean,
    onToggle: () -> Unit,
    onEdit: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val border = if (active || selected) BorderStroke(1.dp, colors.primary) else null
    Card(Modifier.fillMaxWidth(), shape = RoundedCornerShape(20.dp), border = border,
        colors = CardDefaults.cardColors(containerColor = colors.surface)) {
        Row(Modifier.fillMaxWidth().padding(end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Checkbox(checked = completed, enabled = canComplete, onCheckedChange = { onToggle() },
                modifier = Modifier.semantics {
                    contentDescription = if (canComplete) "${routine.title} 완료" else "${routine.title} 완료 기록"
                })
            Column(Modifier.weight(1f).padding(vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(routine.timeLabel(), style = MaterialTheme.typography.bodySmall, color = colors.primary)
                Text(routine.title, style = MaterialTheme.typography.titleMedium)
                if (active) Text("진행 중", style = MaterialTheme.typography.labelMedium, color = colors.primary)
            }
            TextButton(onClick = onEdit,
                modifier = Modifier.semantics { contentDescription = "${routine.title} 편집" }) {
                Text("편집")
            }
        }
    }
}

@Composable
private fun DatedScheduleRow(schedule: DatedSchedule, date: LocalDate, active: Boolean, onOpen: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Card(onClick = onOpen, modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(20.dp),
        border = if (active) BorderStroke(1.dp, colors.primary) else null,
        colors = CardDefaults.cardColors(containerColor = colors.surface)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(schedule.timeLabelOn(date), style = MaterialTheme.typography.bodySmall, color = colors.primary)
                Text(schedule.title, style = MaterialTheme.typography.titleMedium)
                Text(if (schedule.fixed) "고정 일정" else "유연 일정", style = MaterialTheme.typography.labelMedium)
                if (active) Text("진행 중", style = MaterialTheme.typography.labelMedium, color = colors.primary)
            }
            Text("상세", color = colors.primary, style = MaterialTheme.typography.labelLarge)
        }
    }
}

@Composable
private fun RoutineEditor(existing: Routine?, onClose: () -> Unit, onSave: (Routine) -> Unit, onDelete: () -> Unit) {
    val context = LocalContext.current
    var title by rememberSaveable { mutableStateOf(existing?.title.orEmpty()) }
    var startText by rememberSaveable { mutableStateOf((existing?.start ?: LocalTime.of(7, 0)).format(routineTimeFormat)) }
    var endText by rememberSaveable {
        mutableStateOf(if (existing == null) "07:30" else existing.end?.format(routineTimeFormat).orEmpty())
    }
    var endPicked by rememberSaveable { mutableStateOf(existing != null) }
    var confirmDeletion by rememberSaveable { mutableStateOf(false) }
    val start = LocalTime.parse(startText)
    val end = endText.takeIf(String::isNotEmpty)?.let(LocalTime::parse)
    val sameTime = end == start

    fun pickTime(current: LocalTime, setTime: (LocalTime) -> Unit) {
        TimePickerDialog(context, { _, hour, minute -> setTime(LocalTime.of(hour, minute)) },
            current.hour, current.minute, true).show()
    }

    if (confirmDeletion) {
        AlertDialog(onDismissRequest = { confirmDeletion = false }, title = { Text("루틴 삭제") },
            text = { Text("${existing?.title.orEmpty()} 루틴을 삭제할까요?") },
            confirmButton = { TextButton(onClick = onDelete) { Text("삭제") } },
            dismissButton = { TextButton(onClick = { confirmDeletion = false }) { Text("돌아가기") } })
        return
    }

    AlertDialog(
        onDismissRequest = onClose,
        title = { Text(if (existing == null) "루틴 추가" else "루틴 편집") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(value = title, onValueChange = { title = it.take(80) },
                    label = { Text("루틴 이름") }, maxLines = 3, modifier = Modifier.fillMaxWidth())
                OutlinedButton(onClick = {
                    pickTime(start) { picked ->
                        startText = picked.format(routineTimeFormat)
                        if (!endPicked) endText = picked.plusMinutes(30).format(routineTimeFormat)
                    }
                }) { Text("시작 시각 $startText") }
                OutlinedButton(onClick = {
                    pickTime(end ?: start.plusMinutes(30)) { picked ->
                        endPicked = true
                        endText = picked.format(routineTimeFormat)
                    }
                }) { Text(if (end == null) "종료 시각 설정" else "종료 시각 $endText") }
                when {
                    sameTime -> Text("시작과 종료 시각이 같아요. 종료 시각을 바꿔 주세요.",
                        color = MaterialTheme.colorScheme.error)
                    end != null && end < start -> Text("다음 날 ${endText}에 끝나는 루틴이에요.")
                    end == null -> Text("종료 시각을 설정하면 원형 시간표에 루틴 길이를 표시해요.")
                }
                Text("매일 표시돼요.", style = MaterialTheme.typography.bodySmall)
                if (existing != null) TextButton(onClick = { confirmDeletion = true }) { Text("루틴 삭제") }
            }
        },
        confirmButton = {
            TextButton(enabled = title.isNotBlank() && !sameTime, onClick = {
                onSave(Routine(existing?.id ?: UUID.randomUUID().toString(), title.trim(), start, end,
                    existing?.completedDates.orEmpty()))
            }) { Text("저장") }
        },
        dismissButton = { TextButton(onClick = onClose) { Text("취소") } },
    )
}
