package photos.bowerbird

import android.app.Activity
import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.os.Build
import android.webkit.WebView
import androidx.annotation.RequiresApi
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.InputStream
import java.time.Instant
import org.json.JSONArray

/**
 * How the app's earlier runs ended, for the shell to log: Android's exit records not reported yet,
 * and what went wrong where the last run wrote it to [crashFile] (its first Rust panic, from
 * `exits.rs`, then any uncaught Kotlin exception).
 */
@TauriPlugin
class ExitsPlugin(private val activity: Activity) : Plugin(activity) {
    private val crashFile = File(activity.filesDir, "last-crash.txt")
    private val reportedFile = File(activity.filesDir, "exits-reported.txt")

    override fun load(webView: WebView) {
        if (handling) return
        handling = true
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, err ->
            runCatching { crashFile.appendText("${thread.name}: ${err.stackTraceToString()}") }
            previous?.uncaughtException(thread, err)
        }
    }

    @Command
    fun lastExit(invoke: Invoke) {
        // Commands run on the UI thread, and tombstones and ANR traces are large.
        Thread {
            try {
                val crash = crashFile.takeIf { it.exists() }?.let { file ->
                    runCatching { file.readText() }.getOrNull().also { file.delete() }
                }
                invoke.resolve(JSObject().apply {
                    put("exits", JSONArray(unreportedExits()))
                    put("crash", crash)
                    put("crashFile", crashFile.absolutePath)
                })
            } catch (err: Exception) {
                invoke.reject(err.message ?: err.toString())
            }
        }.start()
    }

    private fun unreportedExits(): List<String> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return emptyList()
        val manager = activity.getSystemService(ActivityManager::class.java)
        val reported = runCatching { reportedFile.readText().trim().toLong() }.getOrDefault(0L)
        // More than the last: installing a build records its own exit over the crash before it.
        val exits = manager.getHistoricalProcessExitReasons(activity.packageName, 0, EXITS_REPORTED)
            .filter { it.timestamp > reported }
        val described = exits.map(::describe)
        exits.maxOfOrNull { it.timestamp }?.let { newest -> runCatching { reportedFile.writeText("$newest") } }
        return described
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun describe(exit: ApplicationExitInfo): String {
        val summary = "${reasonName(exit.reason)} at ${Instant.ofEpochMilli(exit.timestamp)}: " +
            "${exit.description ?: "no description"}, status ${exit.status}, importance ${exit.importance}, " +
            "pss ${exit.pss / 1024} MB, rss ${exit.rss / 1024} MB"
        val trace = when {
            exit.reason == ApplicationExitInfo.REASON_ANR ->
                runCatching { exit.traceInputStream?.let { readUpTo(it, ANR_TRACE_CHARS) } }.getOrNull()
            exit.reason == ApplicationExitInfo.REASON_CRASH_NATIVE && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ->
                runCatching { exit.traceInputStream?.use { Tombstone.describe(it.readBytes()) } }
                    .getOrElse { "the tombstone would not read: $it" }
            else -> null
        }
        return if (trace == null) summary else "$summary\n$trace"
    }

    private fun readUpTo(stream: InputStream, chars: Int): String = stream.bufferedReader().use { reader ->
        val buffer = CharArray(chars)
        var read = 0
        while (read < chars) {
            val n = reader.read(buffer, read, chars - read)
            if (n < 0) break
            read += n
        }
        String(buffer, 0, read)
    }

    private fun reasonName(reason: Int): String = when (reason) {
        ApplicationExitInfo.REASON_ANR -> "ANR"
        ApplicationExitInfo.REASON_CRASH -> "crash"
        ApplicationExitInfo.REASON_CRASH_NATIVE -> "native crash"
        ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "dependency died"
        ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "excessive resource usage"
        ApplicationExitInfo.REASON_EXIT_SELF -> "exited itself"
        ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "initialisation failure"
        ApplicationExitInfo.REASON_LOW_MEMORY -> "low memory"
        ApplicationExitInfo.REASON_OTHER -> "other"
        ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "permission change"
        ApplicationExitInfo.REASON_SIGNALED -> "signalled"
        ApplicationExitInfo.REASON_USER_REQUESTED -> "user requested"
        ApplicationExitInfo.REASON_USER_STOPPED -> "user stopped"
        else -> "reason $reason"
    }

    private companion object {
        const val ANR_TRACE_CHARS = 20_000
        const val EXITS_REPORTED = 5

        // Per process, as the handler is, however many plugins load.
        var handling = false
    }
}
