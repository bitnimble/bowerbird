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
import java.time.Instant
import org.json.JSONArray

/**
 * How the app's earlier runs ended, for the shell to log: Android's exit records, and what crashed
 * it where this run wrote that down to [crashFile] (a Kotlin exception here, a Rust panic in `exits.rs`).
 */
@TauriPlugin
class ExitsPlugin(private val activity: Activity) : Plugin(activity) {
    private val crashFile = File(activity.filesDir, "last-crash.txt")

    override fun load(webView: WebView) {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, err ->
            runCatching { crashFile.writeText("${thread.name}: ${err.stackTraceToString()}") }
            previous?.uncaughtException(thread, err)
        }
    }

    @Command
    fun lastExit(invoke: Invoke) {
        val crash = crashFile.takeIf { it.exists() }?.let { file ->
            runCatching { file.readText() }.getOrNull().also { file.delete() }
        }
        invoke.resolve(JSObject().apply {
            put("exits", JSONArray(lastExits()))
            put("crash", crash)
            put("crashFile", crashFile.absolutePath)
        })
    }

    private fun lastExits(): List<String> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return emptyList()
        val manager = activity.getSystemService(ActivityManager::class.java)
        // More than the last: installing a build records its own exit over the crash before it.
        return manager.getHistoricalProcessExitReasons(activity.packageName, 0, EXITS_REPORTED).map(::describe)
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun describe(exit: ApplicationExitInfo): String {
        val summary = "${reasonName(exit.reason)} at ${Instant.ofEpochMilli(exit.timestamp)}: " +
            "${exit.description ?: "no description"}, status ${exit.status}, importance ${exit.importance}, " +
            "pss ${exit.pss / 1024} MB, rss ${exit.rss / 1024} MB"
        val trace = when {
            exit.reason == ApplicationExitInfo.REASON_ANR ->
                runCatching { exit.traceInputStream?.bufferedReader()?.use { it.readText() } }.getOrNull()
                    ?.take(ANR_TRACE_CHARS)
            exit.reason == ApplicationExitInfo.REASON_CRASH_NATIVE && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ->
                runCatching { exit.traceInputStream?.use { Tombstone.describe(it.readBytes()) } }
                    .getOrElse { "the tombstone would not read: $it" }
            else -> null
        }
        return if (trace == null) summary else "$summary\n$trace"
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
    }
}
