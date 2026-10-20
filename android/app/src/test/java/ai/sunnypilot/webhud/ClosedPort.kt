package ai.sunnypilot.webhud

import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import kotlin.random.Random

/**
 * A loopback port nothing listens on, for tests that need a connection refused. It comes from below the ports the
 * system hands out by itself (ephemeral: 49152+ on macOS and Windows, 32768+ on Linux). A `ServerSocket(0)` port
 * closed at once is free again and in that range: another test's server can bind it, or a connect's own source
 * port can land on it so the socket connects to itself, and the "closed" port answers. Down here neither happens;
 * only something binding this very port by number could.
 */
fun closedPort(): Int {
    repeat(200) {
        val port = Random.nextInt(20_000, 32_768)
        try {
            ServerSocket(port, 1, InetAddress.getLoopbackAddress()).close()   // free just now: nothing listens
            return port
        } catch (e: IOException) {
            // taken: another
        }
    }
    error("no free port in 20000-32767")
}
