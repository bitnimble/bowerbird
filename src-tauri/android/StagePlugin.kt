package photos.bowerbird

import android.app.Activity
import android.util.Log
import android.view.Surface
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.widget.FrameLayout
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.nio.channels.Channels
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.LinkedBlockingDeque
import kotlin.concurrent.thread
import kotlin.math.roundToInt

@InvokeArg
class StagePrepareArgs {
    var sequence = 0L
    lateinit var url: String
    var urgent = false
}

@InvokeArg
class StageReleaseArgs {
    var sequence = 0L
    lateinit var url: String
}

@InvokeArg
class StageShowArgs {
    var sequence = 0L
    lateinit var url: String
    var left = 0
    var top = 0
    var width = 0
    var height = 0
    var headroom = 0f
    var white = 0f
}

@InvokeArg
class StageWarmArgs {
    var white = 0f
}

@InvokeArg
class StageHideArgs {
    var sequence = 0L
}

/** scRGB window behind the transparent page, drawn by librawshim through `stage.rs`. */
@TauriPlugin
class StagePlugin(private val activity: Activity) : Plugin(activity) {
    private class Prepared(val handle: Long, val width: Int, val height: Int)

    private class Target(
        val ticket: Int,
        val url: String,
        val boxWidth: Int,
        val boxHeight: Int,
        val density: Float,
        val headroom: Float,
        val white: Float,
    )

    private class Placed(
        val target: Target,
        val width: Int,
        val height: Int,
        val fitLeft: Int,
        val fitTop: Int,
        val fitWidth: Int,
        val fitHeight: Int,
    )

    private val pending = LinkedBlockingDeque<Runnable>()
    private val wanted: MutableSet<String> = ConcurrentHashMap.newKeySet()

    // UI thread, apart from `ticket`, which the worker reads to drop a superseded draw.
    private var view: SurfaceView? = null
    private var waiting: Invoke? = null
    private var sequence = 0L
    private val stamps = HashMap<String, Long>()
    private var fixed = Pair(0, 0)
    @Volatile private var ticket = 0
    @Volatile private var placed: Placed? = null

    // Worker.
    private val pictures = HashMap<String, Prepared>()
    private var shownUrl: String? = null

    // Under `drawing`: `surfaceDestroyed` takes it, so no draw outlives the window.
    private val drawing = Any()
    private var surface: Surface? = null
    private var window = 0L
    private var windowWidth = 0
    private var windowHeight = 0

    init {
        thread(name = "stage", isDaemon = true) {
            while (true) {
                val task = pending.takeFirst()
                try {
                    task.run()
                } catch (err: Throwable) {
                    // A throw here would end the app, and leave the page waiting on its answer.
                    Log.w(TAG, "the stage behind the page failed", err)
                    activity.runOnUiThread { answer(false) }
                }
            }
        }
    }

    /** Resolves `ready` with the picture's shown size, `missing` on a 404, else `refused`. */
    @Command
    fun prepare(invoke: Invoke) {
        val args = invoke.parseArgs(StagePrepareArgs::class.java)
        if (!newest(args.url, args.sequence)) {
            invoke.resolve(state("refused"))
            return
        }
        wanted.add(args.url)
        val task = Runnable {
            try {
                invoke.resolve(prepared(args.url))
            } catch (err: Throwable) {
                Log.w(TAG, "could not prepare ${args.url}", err)
                invoke.reject(err.toString())
            }
        }
        if (args.urgent) pending.offerFirst(task) else pending.offerLast(task)
    }

    @Command
    fun warm(invoke: Invoke) {
        val white = invoke.parseArgs(StageWarmArgs::class.java).white
        pending.offerFirst(
            Runnable {
                try {
                    if (warm(white)) invoke.resolve() else invoke.reject("the stage behind the page could not compile")
                } catch (err: Throwable) {
                    invoke.reject(err.toString())
                }
            },
        )
    }

    @Command
    fun release(invoke: Invoke) {
        val args = invoke.parseArgs(StageReleaseArgs::class.java)
        val url = args.url
        if (!newest(url, args.sequence)) {
            invoke.resolve()
            return
        }
        wanted.remove(url)
        pending.offerLast(Runnable { if (url !in wanted && url != shownUrl) forget(url) })
        invoke.resolve()
    }

    @Command
    fun show(invoke: Invoke) {
        val args = invoke.parseArgs(StageShowArgs::class.java)
        if (!overtakes(args.sequence)) {
            invoke.resolve(shown(false))
            return
        }
        answer(false)
        val mine = ++ticket
        if (args.width <= 0 || args.height <= 0) {
            withdraw()
            invoke.resolve(shown(false))
            return
        }
        waiting = invoke
        val shown = ensureView()
        val current = shown.layoutParams as? FrameLayout.LayoutParams
        if (
            current?.leftMargin != args.left ||
            current.topMargin != args.top ||
            current.width != args.width ||
            current.height != args.height
        ) {
            shown.layoutParams =
                FrameLayout.LayoutParams(args.width, args.height).apply {
                    leftMargin = args.left
                    topMargin = args.top
                }
        }
        @Suppress("DEPRECATION")
        val mode = activity.windowManager.defaultDisplay.mode
        val density = maxOf(1f, mode.physicalWidth.toFloat() / activity.window.decorView.width.coerceAtLeast(1))
        val target = Target(mine, args.url, args.width, args.height, density, args.headroom, args.white)
        pending.offerFirst(Runnable { place(target) })
    }

    /** A fresh page: whatever the last one prepared or showed goes. */
    @Command
    fun reset(invoke: Invoke) {
        wanted.clear()
        ++ticket
        answer(false)
        withdraw()
        pending.offerLast(Runnable { pictures.keys.filter { it !in wanted && it != shownUrl }.forEach(::forget) })
        invoke.resolve()
    }

    @Command
    fun hide(invoke: Invoke) {
        if (overtakes(invoke.parseArgs(StageHideArgs::class.java).sequence)) {
            ++ticket
            answer(false)
            withdraw()
        }
        invoke.resolve()
    }

    // Commands run here on the UI thread, but cross `stage.rs` as tasks of their own, so they can
    // arrive out of order.
    // Commands can arrive out of order: a prepare overtaken by its release would hold the photo forever.
    private fun newest(url: String, asked: Long): Boolean {
        if (asked <= (stamps[url] ?: 0L)) return false
        stamps[url] = asked
        return true
    }

    private fun overtakes(asked: Long): Boolean {
        if (asked <= sequence) return false
        sequence = asked
        return true
    }

    private fun withdraw() {
        placed = null
        view?.visibility = View.GONE
        val mine = ticket
        pending.offerLast(Runnable { if (mine == ticket) leave() })
    }

    private fun prepared(url: String): JSObject {
        pictures[url]?.let { return ready(it) }
        if (url !in wanted && url != shownUrl) return state("refused")
        if (url.startsWith(PATTERN)) {
            val size = IntArray(2)
            val handle = url.removePrefix(PATTERN).toFloatOrNull()?.let { flat(it, size) } ?: 0L
            if (handle == 0L) return state("refused")
            return ready(Prepared(handle, size[0], size[1]).also { pictures[url] = it })
        }
        val avif = when (val fetched = fetch(url)) {
            is Fetched.Missing -> return state("missing")
            is Fetched.Failed -> return state("refused")
            is Fetched.Avif -> fetched
        }
        val size = IntArray(2)
        val handle = picture(avif.bytes, avif.length, size)
        if (handle == 0L) return state("refused")
        val picture = Prepared(handle, size[0], size[1])
        pictures[url] = picture
        if (url !in wanted && url != shownUrl) {
            forget(url)
            return state("refused")
        }
        return ready(picture)
    }

    private fun place(target: Target) {
        if (target.ticket != ticket) return
        val previous = shownUrl
        shownUrl = target.url
        if (previous != null && previous != target.url && previous !in wanted) forget(previous)
        val picture = pictures[target.url] ?: run {
            prepared(target.url)
            pictures[target.url]
        }
        if (picture == null) {
            refuse(target)
            return
        }
        val scale = minOf(target.boxWidth.toFloat() / picture.width, target.boxHeight.toFloat() / picture.height)
        // Display pixels, or the picture's where fewer: drawn at most 1:1, the compositor scales the rest.
        val perPagePixel = minOf(target.density, 1f / scale)
        val width = (target.boxWidth * perPagePixel).roundToInt().coerceAtLeast(1)
        val height = (target.boxHeight * perPagePixel).roundToInt().coerceAtLeast(1)
        val fitWidth = (picture.width * scale * perPagePixel).roundToInt().coerceIn(1, width)
        val fitHeight = (picture.height * scale * perPagePixel).roundToInt().coerceIn(1, height)
        val placement = Placed(
            target, width, height, (width - fitWidth) / 2, (height - fitHeight) / 2, fitWidth, fitHeight,
        )
        activity.runOnUiThread {
            if (target.ticket != ticket) return@runOnUiThread
            placed = placement
            val shown = ensureView()
            shown.visibility = View.VISIBLE
            if (fixed != Pair(width, height)) {
                fixed = Pair(width, height)
                shown.holder.setFixedSize(width, height)
            }
            pending.offerFirst(Runnable { draw() })
        }
    }

    private fun draw() {
        val placement = placed ?: return
        val target = placement.target
        val picture = pictures[target.url] ?: return refuse(target)
        // Compiled outside `drawing`: the UI thread's surface callbacks wait on it.
        warm(target.white)
        val drawn = synchronized(drawing) {
            // `surfaceChanged` draws again once the window takes the placement's size.
            if (windowWidth != placement.width || windowHeight != placement.height) return
            val at = surface ?: return
            if (window == 0L) window = attach(at, windowWidth, windowHeight)
            window != 0L &&
                present(
                    window, picture.handle, windowWidth, windowHeight,
                    placement.fitLeft, placement.fitTop, placement.fitWidth, placement.fitHeight,
                    target.headroom, target.white,
                )
        }
        activity.runOnUiThread { if (target.ticket == ticket) answer(drawn) }
    }

    private fun refuse(target: Target) {
        activity.runOnUiThread {
            if (target.ticket != ticket) return@runOnUiThread
            answer(false)
            withdraw()
        }
    }

    private fun leave() {
        val left = shownUrl ?: return
        shownUrl = null
        if (left !in wanted) forget(left)
    }

    private fun forget(url: String) {
        pictures.remove(url)?.let { pictureFree(it.handle) }
    }

    private sealed interface Fetched {
        class Avif(val bytes: ByteBuffer, val length: Int) : Fetched
        object Missing : Fetched
        object Failed : Fetched
    }

    // With the page's cookie, which carries the server's token. Read straight into memory the
    // library reads from, rather than through a Java array it would copy out of.
    private fun fetch(url: String): Fetched {
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = FETCH_TIMEOUT_MS
            connection.readTimeout = FETCH_TIMEOUT_MS
            // Transparent gzip would drop the length the buffer is sized by.
            connection.setRequestProperty("Accept-Encoding", "identity")
            CookieManager.getInstance().getCookie(url)?.let { connection.setRequestProperty("Cookie", it) }
            val code = connection.responseCode
            if (code == HttpURLConnection.HTTP_NOT_FOUND) return Fetched.Missing
            if (code != HttpURLConnection.HTTP_OK) {
                Log.w(TAG, "the server answered $code for $url")
                return Fetched.Failed
            }
            val length = connection.contentLengthLong
            connection.inputStream.use { stream ->
                if (length !in 1..Int.MAX_VALUE) {
                    val bytes = stream.readBytes()
                    return Fetched.Avif(ByteBuffer.allocateDirect(bytes.size).put(bytes), bytes.size)
                }
                val buffer = ByteBuffer.allocateDirect(length.toInt())
                val channel = Channels.newChannel(stream)
                while (buffer.hasRemaining() && channel.read(buffer) >= 0) Unit
                return Fetched.Avif(buffer, buffer.position())
            }
        } catch (err: Exception) {
            Log.w(TAG, "could not fetch $url: $err")
            return Fetched.Failed
        } finally {
            connection.disconnect()
        }
    }

    private fun answer(drawn: Boolean) {
        waiting?.resolve(shown(drawn))
        waiting = null
    }

    private fun shown(drawn: Boolean) = JSObject().apply { put("drawn", drawn) }

    private fun state(state: String) = JSObject().apply { put("state", state) }

    private fun ready(picture: Prepared) =
        state("ready").apply {
            put("width", picture.width)
            put("height", picture.height)
        }

    private fun ensureView(): SurfaceView {
        view?.let { return it }
        val created = SurfaceView(activity)
        created.holder.addCallback(
            object : SurfaceHolder.Callback {
                override fun surfaceCreated(holder: SurfaceHolder) {}

                override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
                    synchronized(drawing) {
                        surface = holder.surface
                        windowWidth = width
                        windowHeight = height
                    }
                    pending.offerFirst(Runnable { draw() })
                }

                override fun surfaceDestroyed(holder: SurfaceHolder) {
                    synchronized(drawing) {
                        detach(window)
                        window = 0L
                        surface = null
                        windowWidth = 0
                        windowHeight = 0
                    }
                }
            },
        )
        // Behind the WebView, which draws the page's controls over it.
        activity.findViewById<ViewGroup>(android.R.id.content).addView(created, 0)
        view = created
        return created
    }

    companion object {
        private const val TAG = "StagePlugin"
        private const val FETCH_TIMEOUT_MS = 10_000

        // `pattern:<nits>`: a flat patch built here rather than fetched (`calibrate_hdr_page.tsx`).
        private const val PATTERN = "pattern:"

        // `stage.rs`, in the app's own library, which the activity has loaded.
        @JvmStatic external fun attach(surface: Surface, width: Int, height: Int): Long

        @JvmStatic external fun detach(window: Long)

        @JvmStatic external fun picture(avif: ByteBuffer, length: Int, size: IntArray): Long

        @JvmStatic external fun pictureFree(picture: Long)

        @JvmStatic external fun warm(white: Float): Boolean

        @JvmStatic external fun flat(nits: Float, size: IntArray): Long

        @JvmStatic external fun present(
            window: Long,
            picture: Long,
            width: Int,
            height: Int,
            fitLeft: Int,
            fitTop: Int,
            fitWidth: Int,
            fitHeight: Int,
            headroom: Float,
            white: Float,
        ): Boolean
    }
}
