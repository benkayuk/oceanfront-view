package ai.sunnypilot.webhud

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.Socket

/** The server's own API under /app/ (the Comma tab): method, path, query, body and token reach the handler. */
class AppApiTest {
    private var seen: List<Any?> = emptyList()
    private val server = LocalServer(null, "test", app = { method, path, query, body, token ->
        seen = listOf(method, path, query, body, token)
        if (token == "secret") 200 to "{\"ok\":true}" else 403 to "{\"error\":\"no\"}"
    }) {}

    init {
        server.start()
    }

    @After
    fun tearDown() = server.stop()

    private fun request(raw: String): String = Socket("127.0.0.1", server.port).use { s ->
        s.soTimeout = 3000
        s.getOutputStream().write(raw.toByteArray())
        s.getInputStream().readBytes().toString(Charsets.UTF_8)
    }

    @Test
    fun postWithBodyAndQuery() {
        val body = "{\"action\":\"restart\"}"
        val res = request("POST /app/comma/jobs?from=12&x=a%20b HTTP/1.1\r\nHost: 127.0.0.1\r\nX-App-Token: secret\r\n" +
            "Content-Length: ${body.length}\r\n\r\n$body")
        assertTrue(res, res.startsWith("HTTP/1.1 200"))
        assertTrue(res, res.endsWith("{\"ok\":true}"))
        assertEquals(listOf("POST", "/app/comma/jobs", mapOf("from" to "12", "x" to "a b"), body, "secret"), seen)
    }

    @Test
    fun theHandlerSaysNoWithoutTheToken() {
        val res = request("GET /app/comma HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
        assertTrue(res, res.startsWith("HTTP/1.1 403"))
        assertEquals(null, seen[4])
        assertEquals(null, seen[3])
    }
}
