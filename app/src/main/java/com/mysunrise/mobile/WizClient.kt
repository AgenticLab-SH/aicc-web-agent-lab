package com.mysunrise.mobile

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress

/**
 * WiZ LAN protocol is community-documented, not a guaranteed vendor API.
 * No WiZ credentials are stored. Never forward this UDP port to the internet.
 */
object WizClient {
    private const val PORT = 38899

    private fun address(ip: String): InetAddress {
        val tokens = ip.split(".")
        require(tokens.size == 4 && tokens.all {
            it.length in 1..3 && it.all(Char::isDigit) && (it.toIntOrNull() ?: -1) in 0..255
        }) { "전구의 IPv4 주소를 입력하세요." }
        return InetAddress.getByName(ip)
    }

    suspend fun getState(ip: String): JSONObject =
        request(ip, "getPilot", JSONObject())

    suspend fun setLight(ip: String, on: Boolean, dimming: Int? = null, temp: Int? = null) {
        val params = JSONObject().put("state", on)
        if (on && dimming != null) params.put("dimming", dimming.coerceIn(1, 100))
        if (on && temp != null) params.put("temp", temp.coerceIn(2200, 6500))
        val response = request(ip, "setPilot", params)
        check(response.optBoolean("success")) { "전구가 제어 명령을 거절했습니다." }
    }

    suspend fun setRgb(ip: String, r: Int, g: Int, b: Int, brightness: Int) {
        val p = JSONObject().put("state", true)
            .put("r", r.coerceIn(0, 255)).put("g", g.coerceIn(0, 255))
            .put("b", b.coerceIn(0, 255)).put("dimming", brightness.coerceIn(1, 100))
        check(request(ip, "setPilot", p).optBoolean("success")) { "색상 변경 실패" }
    }

    private suspend fun request(ip: String, method: String, params: JSONObject): JSONObject =
        withContext(Dispatchers.IO) {
            val host = address(ip)
            val packetData = JSONObject().put("method", method).put("params", params)
                .toString().toByteArray(Charsets.UTF_8)
            var failure: Exception? = null
            repeat(2) {
                try {
                    DatagramSocket().use { socket ->
                        socket.soTimeout = 1300
                        socket.connect(host, PORT)
                        socket.send(DatagramPacket(packetData, packetData.size))
                        val buffer = ByteArray(2048)
                        val received = DatagramPacket(buffer, buffer.size)
                        socket.receive(received)
                        val response = JSONObject(
                            String(received.data, received.offset, received.length, Charsets.UTF_8)
                        )
                        check(response.optString("method") == method) { "응답 명령 불일치" }
                        val result = response.optJSONObject("result")
                        if (result != null) return@withContext result
                        error("WiZ 응답에 result가 없습니다.")
                    }
                } catch (e: Exception) {
                    failure = e
                }
            }
            throw IllegalStateException("WiZ 로컬 연결 실패: IP·Wi-Fi·로컬 통신 허용 확인", failure)
        }
}
