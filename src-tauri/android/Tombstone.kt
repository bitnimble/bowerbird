package photos.bowerbird

/**
 * What a native crash's tombstone says, from the protobuf `ApplicationExitInfo` hands over:
 * the abort message, the crashing thread's stack, and the process's last log lines. Field numbers
 * are AOSP's `system/core/debuggerd/proto/tombstone.proto`.
 */
object Tombstone {
    private const val FRAMES_SHOWN = 48
    private const val LOG_LINES_SHOWN = 60

    fun describe(bytes: ByteArray): String {
        var tid = 0L
        var abort: String? = null
        var signal: String? = null
        val threads = mutableMapOf<Long, ByteArray>()
        val logs = mutableListOf<String>()
        Fields(bytes).forEach { field, value ->
            when (field) {
                6 -> tid = value as Long
                10 -> signal = Fields(value as ByteArray).string(2)
                14 -> abort = String(value as ByteArray)
                16 -> {
                    val entry = Fields(value as ByteArray)
                    entry.bytes(2)?.let { threads[entry.long(1) ?: 0L] = it }
                }
                18 -> Fields(value as ByteArray).forEach { logField, log ->
                    if (logField == 2) {
                        val line = Fields(log as ByteArray)
                        logs += "${line.string(1)} ${line.long(3)} ${line.string(5)}: ${line.string(6)}"
                    }
                }
            }
        }
        val crashed = threads[tid]?.let(::thread) ?: "no stack for thread $tid"
        return listOfNotNull(
            "signal ${signal ?: "unknown"}",
            abort?.let { "abort: $it" },
            crashed,
            "last log lines:",
            logs.takeLast(LOG_LINES_SHOWN).joinToString("\n"),
        ).joinToString("\n")
    }

    private fun thread(bytes: ByteArray): String {
        val thread = Fields(bytes)
        val frames = thread.all(4).take(FRAMES_SHOWN).mapIndexed { i, frame ->
            val f = Fields(frame as ByteArray)
            val function = f.string(4)?.let { " ($it+${f.long(5)})" } ?: ""
            "  #%02d pc %x %s%s".format(i, f.long(1) ?: 0L, f.string(6) ?: "?", function)
        }
        return "thread ${thread.string(2)} (${thread.long(1)}):\n${frames.joinToString("\n")}"
    }

    /** One message's fields: varints as Long, length-delimited as ByteArray, fixed ones skipped. */
    private class Fields(private val bytes: ByteArray) {
        private val read: List<Pair<Int, Any>> by lazy { parse() }

        fun forEach(each: (Int, Any) -> Unit) = read.forEach { (field, value) -> each(field, value) }
        fun all(field: Int): List<Any> = read.filter { it.first == field }.map { it.second }
        fun long(field: Int): Long? = all(field).lastOrNull() as? Long
        fun bytes(field: Int): ByteArray? = all(field).lastOrNull() as? ByteArray
        fun string(field: Int): String? = bytes(field)?.let { String(it) }

        private fun parse(): List<Pair<Int, Any>> {
            val out = mutableListOf<Pair<Int, Any>>()
            var at = 0
            fun varint(): Long {
                var value = 0L
                var shift = 0
                while (true) {
                    val b = bytes[at++].toInt()
                    value = value or ((b and 0x7f).toLong() shl shift)
                    if (b and 0x80 == 0) return value
                    shift += 7
                }
            }
            while (at < bytes.size) {
                val key = varint()
                val field = (key ushr 3).toInt()
                when ((key and 7).toInt()) {
                    0 -> out += field to varint()
                    1 -> at += 8
                    2 -> {
                        val length = varint().toInt()
                        out += field to bytes.copyOfRange(at, at + length)
                        at += length
                    }
                    5 -> at += 4
                    else -> return out
                }
            }
            return out
        }
    }
}
