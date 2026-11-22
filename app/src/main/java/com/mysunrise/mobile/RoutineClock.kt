package com.mysunrise.mobile

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import java.time.LocalDate
import java.time.LocalDateTime
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin

private val clockColors = listOf(
    Color(0xFF0875D1), Color(0xFF19836F), Color(0xFF7656BD),
    Color(0xFFC35142), Color(0xFF92700B), Color(0xFF347F9E),
)

@Composable
internal fun RoutineClock(
    routines: List<Routine>,
    date: LocalDate,
    now: LocalDateTime?,
    hasDatedSchedules: Boolean,
    onSelect: (String) -> Unit,
) {
    val segments = remember(routines) { clockSegments(routines) }
    val trackCount = (segments.maxOfOrNull { it.track } ?: 0) + 1
    val selectRoutine = rememberUpdatedState(onSelect)
    val minute = now?.toLocalTime()?.minuteOfDay()
    val nowLabel = now?.toLocalTime()?.format(routineTimeFormat)
    val currentEntry = minute?.let { current -> routines.firstOrNull { it.isActiveAt(current) } }
    val largeText = LocalDensity.current.fontScale > 1.3f
    val grid = MaterialTheme.colorScheme.surfaceVariant
    val marks = MaterialTheme.colorScheme.onSurfaceVariant
    val primary = MaterialTheme.colorScheme.primary
    val ink = MaterialTheme.colorScheme.onSurface
    val surface = MaterialTheme.colorScheme.surface

    Card(Modifier.fillMaxWidth(), shape = RoundedCornerShape(28.dp),
        colors = CardDefaults.cardColors(containerColor = surface)) {
        Column(Modifier.fillMaxWidth().padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("원형 시간표", Modifier.align(Alignment.Start), style = MaterialTheme.typography.titleLarge)
            if (largeText && nowLabel != null) Text("현재 시각 $nowLabel", style = MaterialTheme.typography.titleMedium)
            Box(Modifier.widthIn(max = 360.dp).fillMaxWidth().aspectRatio(1f)) {
                Canvas(Modifier.matchParentSize()
                    .semantics { contentDescription = "24시간 원형 시간표. 아래 목록에서도 시간과 상세를 확인할 수 있어요." }
                    .pointerInput(segments, trackCount) {
                        detectTapGestures { point ->
                            val distanceFromCenter = point - Offset(size.width / 2f, size.height / 2f)
                            val geometry = ClockGeometry(minOf(size.width, size.height).toFloat(), trackCount)
                            val hit = segments.minByOrNull { geometry.distanceTo(it, distanceFromCenter) }
                            if (hit != null && geometry.distanceTo(hit, distanceFromCenter) <= 24.dp.toPx()) {
                                selectRoutine.value(hit.routine.id)
                            }
                        }
                    }) {
                    val geometry = ClockGeometry(size.minDimension, trackCount)
                    drawCircle(grid, radius = geometry.dialRadius, style = Stroke(width = 1.dp.toPx()))
                    repeat(24) { hour ->
                        val angle = clockAngle(hour * 60f)
                        val cardinal = hour % 6 == 0
                        drawLine(
                            if (cardinal) marks else grid,
                            center + clockOffset(angle, geometry.dialRadius - if (cardinal) 6.dp.toPx() else 4.dp.toPx()),
                            center + clockOffset(angle, geometry.dialRadius),
                            strokeWidth = 1.dp.toPx(),
                        )
                    }
                    val stroke = minOf(14.dp.toPx(), geometry.trackSpacing * .72f)
                    segments.forEachIndexed { index, segment ->
                        val routine = segment.routine
                        val radius = geometry.radius(segment.track)
                        val angle = clockAngle(routine.startMinute.toFloat())
                        val active = minute != null && routine.isActiveAt(minute)
                        val color = clockColors[index % clockColors.size].copy(
                            alpha = if (date in routine.completedDates) .43f else 1f,
                        )
                        val outline = minOf(stroke * .22f, 1.5.dp.toPx())
                        val duration = routine.durationMinutes
                        if (duration == null) {
                            val start = center + clockOffset(angle, radius)
                            if (active) {
                                drawCircle(ink, stroke / 2 + outline, start)
                                drawCircle(surface, stroke / 2, start)
                            }
                            drawCircle(color, stroke / 2, start)
                        } else {
                            val topLeft = center - Offset(radius, radius)
                            val bounds = Size(radius * 2, radius * 2)
                            val arcStyle = Stroke(stroke, cap = StrokeCap.Round)
                            if (active) {
                                drawArc(ink, angle, duration / 4f, false, topLeft, bounds,
                                    style = Stroke(stroke + outline * 2, cap = StrokeCap.Round))
                                drawArc(surface, angle, duration / 4f, false, topLeft, bounds, style = arcStyle)
                            }
                            drawArc(color, angle, duration / 4f, false, topLeft, bounds, style = arcStyle)
                        }
                    }
                    if (minute != null) drawCircle(primary, radius = 3.dp.toPx(),
                        center = center + clockOffset(clockAngle(minute.toFloat()), geometry.dialRadius))
                }
                Text("00", Modifier.align(Alignment.TopCenter), style = MaterialTheme.typography.labelMedium)
                Text("06", Modifier.align(Alignment.CenterEnd), style = MaterialTheme.typography.labelMedium)
                Text("12", Modifier.align(Alignment.BottomCenter), style = MaterialTheme.typography.labelMedium)
                Text("18", Modifier.align(Alignment.CenterStart), style = MaterialTheme.typography.labelMedium)
                if (!largeText && nowLabel != null) {
                    Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("현재 시각", style = MaterialTheme.typography.labelSmall, color = marks)
                        Text(nowLabel, style = MaterialTheme.typography.titleLarge, color = primary)
                    }
                }
            }
            Text(if (hasDatedSchedules) "원을 눌러 일정 상세를 열거나 루틴 목록으로 이동해요."
                else "원 위의 루틴을 누르면 목록에서 볼 수 있어요.", Modifier.align(Alignment.Start),
                color = marks, style = MaterialTheme.typography.bodySmall)
            if (currentEntry != null) {
                TextButton(onClick = { onSelect(currentEntry.id) }, Modifier.align(Alignment.Start)) {
                    Text(if (hasDatedSchedules) "진행 중인 항목 보기" else "진행 중인 루틴 보기")
                }
            }
        }
    }
}

internal class ClockGeometry(diameter: Float, trackCount: Int) {
    val dialRadius = diameter * .43f
    private val outerRadius = diameter * .37f
    val trackSpacing = minOf(diameter * .062f, diameter * .14f / maxOf(1, trackCount - 1))

    fun radius(track: Int): Float = outerRadius - track * trackSpacing

    fun distanceTo(segment: ClockSegment, point: Offset): Float {
        val angle = Math.toDegrees(atan2(point.y.toDouble(), point.x.toDouble())).toFloat()
        val minute = ((angle + 90f) * 4f + MINUTES_PER_DAY) % MINUTES_PER_DAY
        val start = segment.routine.startMinute.toFloat()
        val elapsed = (minute - start + MINUTES_PER_DAY) % MINUTES_PER_DAY
        val duration = segment.routine.durationMinutes ?: 0
        val closestMinute = when {
            elapsed <= duration -> minute
            elapsed - duration <= MINUTES_PER_DAY - elapsed -> start + duration
            else -> start
        }
        val closest = clockOffset(clockAngle(closestMinute), radius(segment.track))
        return (point - closest).getDistance()
    }
}

private fun clockAngle(minute: Float): Float = minute / 4f - 90f

private fun clockOffset(angle: Float, radius: Float): Offset {
    val radians = Math.toRadians(angle.toDouble())
    return Offset(radius * cos(radians).toFloat(), radius * sin(radians).toFloat())
}
