package com.mysunrise.mobile

import android.Manifest
import android.app.TimePickerDialog
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : ComponentActivity() {
    private val askNotifications = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { /* user choice is respected; notification status appears in system settings */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme(
                colorScheme = lightColorScheme(
                    primary = Color(0xFF0369A1),
                    onPrimary = Color.White,
                    primaryContainer = Color(0xFFE0F2FE),
                    onPrimaryContainer = Color(0xFF075985),
                    background = Color(0xFFF7F9FC),
                    surface = Color.White,
                    onSurface = Color(0xFF0F172A),
                    surfaceVariant = Color(0xFFEEF3F9),
                    onSurfaceVariant = Color(0xFF475569),
                )
            ) {
                RoutineHome {
                    SunriseScreen(
                        onNotifications = {
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                                askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
                            }
                        },
                        onExactAlarmPermission = {
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                                startActivity(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM))
                            }
                        },
                        onPreview = {
                            ContextCompat.startForegroundService(
                                this, Intent(this, SunriseService::class.java).setAction(SunriseService.PREVIEW)
                            )
                        },
                    )
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        if (AlarmScheduler.canSchedule(this) && ConfigStore.load(this).enabled) {
            try { AlarmScheduler.schedule(this) } catch (_: Exception) {}
        }
    }
}

@Composable
private fun SunriseScreen(
    onNotifications: () -> Unit,
    onExactAlarmPermission: () -> Unit,
    onPreview: () -> Unit,
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    var cfg by rememberSaveable { mutableStateOf(ConfigStore.load(context)) }
    var status by rememberSaveable { mutableStateOf("WiZ 연결을 시험한 뒤 알람을 예약하세요.") }
    var busy by remember { mutableStateOf(false) }
    val localFormatter = remember { SimpleDateFormat("M월 d일 (E) HH:mm", Locale.KOREAN) }

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                .padding(horizontal = 22.dp, vertical = 26.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text("빛으로 시작하는 아침", style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.Bold)
            Text("소리 알람은 조명·Wi-Fi 상태와 별도로 실행됩니다.",
                style = MaterialTheme.typography.bodyMedium, color = Color.DarkGray)
            Spacer(Modifier.height(6.dp))

            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)) {
                Column(Modifier.fillMaxWidth().padding(20.dp)) {
                    Text("기상 시각", style = MaterialTheme.typography.labelLarge)
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "%02d:%02d".format(cfg.hour, cfg.minute),
                        fontSize = 52.sp, fontWeight = FontWeight.Bold
                    )
                    OutlinedButton(onClick = {
                        TimePickerDialog(
                            context,
                            { _, h, m -> cfg = cfg.copy(hour = h, minute = m) },
                            cfg.hour, cfg.minute, true,
                        ).show()
                    }) { Text("시간 변경") }
                }
            }

            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.weight(1f)) {
                    Text("자동 기상", fontWeight = FontWeight.SemiBold)
                    Text("예약된 시각에 조명과 알람 실행", style = MaterialTheme.typography.bodySmall)
                }
                Switch(cfg.enabled, onCheckedChange = { cfg = cfg.copy(enabled = it) })
            }
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                Text("평일에만", modifier = Modifier.weight(1f))
                Switch(cfg.weekdaysOnly, onCheckedChange = { cfg = cfg.copy(weekdaysOnly = it) })
            }

            Text("일출 시간  ${cfg.durationMinutes}분", fontWeight = FontWeight.SemiBold)
            Slider(
                value = cfg.durationMinutes.toFloat(),
                onValueChange = { cfg = cfg.copy(durationMinutes = it.toInt().coerceIn(5, 60)) },
                valueRange = 5f..60f,
            )
            Text("최종 밝기  ${cfg.maxBrightness}%", fontWeight = FontWeight.SemiBold)
            Slider(
                value = cfg.maxBrightness.toFloat(),
                onValueChange = { cfg = cfg.copy(maxBrightness = it.toInt().coerceIn(10, 100)) },
                valueRange = 10f..100f,
            )

            HorizontalDivider()
            Text("WiZ 전구 연결", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(
                value = cfg.bulbIp,
                onValueChange = { cfg = cfg.copy(bulbIp = it.trim()) },
                label = { Text("전구 IPv4 주소 (예: 192.0.2.10)") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )
            Text(
                "WiZ 앱에서 로컬 통신을 허용하세요. 전구 IP는 공유기 기기 목록에서 확인하고 IP 예약을 권장합니다.",
                style = MaterialTheme.typography.bodySmall, color = Color.DarkGray
            )

            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    enabled = !busy && cfg.bulbIp.isNotBlank(),
                    onClick = {
                        busy = true
                        scope.launch {
                            status = try {
                                val result = WizClient.getState(cfg.bulbIp)
                                "WiZ 응답 확인: " + if (result.optBoolean("state")) "켜짐" else "꺼짐"
                            } catch (e: Exception) {
                                e.message ?: "연결 실패"
                            }
                            busy = false
                        }
                    },
                    modifier = Modifier.weight(1f),
                ) { Text("연결 확인") }
                OutlinedButton(
                    enabled = !busy && cfg.bulbIp.isNotBlank(),
                    onClick = {
                        busy = true
                        scope.launch {
                            status = try {
                                WizClient.setLight(cfg.bulbIp, true, 20, 2700)
                                "조명을 20% 밝기로 설정했습니다."
                            } catch (e: Exception) { e.message ?: "제어 실패" }
                            busy = false
                        }
                    },
                    modifier = Modifier.weight(1f),
                ) { Text("켜기 시험") }
            }
            OutlinedButton(
                enabled = !busy && cfg.bulbIp.isNotBlank(),
                onClick = {
                    busy = true
                    scope.launch {
                        status = try {
                            WizClient.setLight(cfg.bulbIp, false)
                            "조명을 껐습니다."
                        } catch (e: Exception) { e.message ?: "제어 실패" }
                        busy = false
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("조명 끄기") }

            Button(
                onClick = {
                    ConfigStore.save(context, cfg)
                    if (cfg.enabled && !AlarmScheduler.canSchedule(context)) {
                        status = "정확한 알람 권한이 필요합니다. 권한을 허용한 뒤 예약을 확인하세요."
                        onExactAlarmPermission()
                    } else {
                        status = try {
                            val next = AlarmScheduler.schedule(context)
                            if (next == null) "예약을 껐습니다."
                            else "다음 기상: " + localFormatter.format(Date(next))
                        } catch (e: Exception) { "예약 실패: " + (e.message ?: "설정을 확인하세요.") }
                    }
                    onNotifications()
                },
                modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
            ) { Text(if (cfg.enabled) "설정 저장하고 알람 예약" else "설정 저장 / 예약 끄기") }

            OutlinedButton(
                onClick = {
                    ConfigStore.save(context, cfg)
                    status = try {
                        onPreview()
                        "45초 조명 미리보기를 시작했습니다."
                    } catch (e: Exception) { "미리보기 시작 실패: " + (e.message ?: "") }
                },
                enabled = cfg.bulbIp.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
            ) { Text("45초 일출 미리보기") }

            Card(colors = CardDefaults.cardColors(containerColor = Color.White)) {
                Text(status, Modifier.fillMaxWidth().padding(16.dp),
                    style = MaterialTheme.typography.bodyMedium)
            }
            Text("최초 7일은 기존 휴대폰 시계 알람도 함께 켜두세요.",
                style = MaterialTheme.typography.bodySmall, color = Color.DarkGray)
            Spacer(Modifier.height(12.dp))
        }
    }
}
