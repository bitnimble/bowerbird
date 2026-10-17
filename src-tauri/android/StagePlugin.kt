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
import java.util.concurrent.Executors
import kotlin.math.roundToInt

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
class StageHideArgs {
    var sequence = 0L
}

/**
 * The viewer's HDR photo on a TV, whose WebView composites in SDR: a window behind the transparent
 * page, in scRGB, which librawshim draws into through `stage.rs`. One photo at a time; a newer
 * `show`, or a `hide`, answers the one waiting with `drawn: false`.
 */
@TauriPlugin
class StagePlugin(private val activity: Activity) : Plugin(activity) {
    private class Target(
        val ticket: Int,
        val width: Int,
        val height: Int,
        val headroom: Float,
        val white: Float,
    )

    private val worker = Executors.newSingleThreadExecutor()

    // UI thread, apart from `ticket`, which the worker reads to give up on a superseded fetch.
    private var view: SurfaceView? = null
    private var placedUrl: String? = null
    private var waiting: Invoke? = null
    private var sequence = 0L
    @Volatile private var ticket = 0
    @Volatile private var target: Target? = null

    // Worker.
    private var picture = 0L
    private var pictureUrl: String? = null
    private val pictureSize = IntArray(2)

    // Under `drawing`: `surfaceDestroyed` takes it, so no draw outlives the window.
    private val drawing = Any()
    private var surface: Surface? = null
    private var window = 0L
    private var windowWidth = 0
    private var windowHeight = 0

    @Command
    fun show(invoke: Invoke) {
        val args = invoke.parseArgs(StageShowArgs::class.java)
        if (!overtakes(args.sequence)) {
            invoke.resolve(shown(false))
            return
        }
        answer(false)
        if (args.width <= 0 || args.height <= 0) {
            ++ticket
            withdraw()
            invoke.resolve(shown(false))
            return
        }
        waiting = invoke
        val mine = ++ticket
        // Out of sight until the next one is drawn, which the page covers meanwhile.
        if (args.url != placedUrl) withdraw()
        work(mine) { prepare(mine, args) }
    }

    @Command
    fun hide(invoke: Invoke) {
        if (overtakes(invoke.parseArgs(StageHideArgs::class.java).sequence)) {
            ++ticket
            answer(false)
            withdraw()
            work(ticket) { forgetPicture() }
        }
        invoke.resolve()
    }

    // Commands run here on the UI thread, but cross `stage.rs` as tasks of their own, so they can
    // arrive out of order.
    private fun overtakes(asked: Long): Boolean {
        if (asked <= sequence) return false
        sequence = asked
        return true
    }

    // A throw on the worker would end the app, and leave the page waiting on its answer.
    private fun work(mine: Int, task: () -> Unit) {
        worker.execute {
            try {
                task()
            } catch (err: Throwable) {
                Log.w(TAG, "could not draw the photo behind the page", err)
                activity.runOnUiThread { if (mine == ticket) answer(false) }
            }
        }
    }

    private fun withdraw() {
        target = null
        placedUrl = null
        view?.visibility = View.GONE
    }

    private fun prepare(mine: Int, args: StageShowArgs) {
        if (args.url != pictureUrl) {
            forgetPicture()
            val avif = fetch(args.url, mine)
            picture = if (avif == null) 0L else picture(avif, pictureSize)
            if (picture == 0L) {
                activity.runOnUiThread { if (mine == ticket) answer(false) }
                return
            }
            pictureUrl = args.url
        }
        val (width, height) = pictureSize
        activity.runOnUiThread {
            if (mine != ticket) return@runOnUiThread
            try {
                place(mine, args, width, height)
            } catch (err: Exception) {
                Log.w(TAG, "could not place the photo behind the page", err)
                withdraw()
                answer(false)
            }
        }
    }

    // With the page's cookie, which carries the server's token. A 404 is a rendition the page has
    // asked the server to build.
    private fun fetch(url: String, mine: Int): ByteArray? {
        repeat(FETCH_ATTEMPTS) {
            if (mine != ticket) return null
            val connection = URL(url).openConnection() as HttpURLConnection
            try {
                connection.connectTimeout = FETCH_TIMEOUT_MS
                connection.readTimeout = FETCH_TIMEOUT_MS
                CookieManager.getInstance().getCookie(url)?.let { connection.setRequestProperty("Cookie", it) }
                val code = connection.responseCode
                if (code == HttpURLConnection.HTTP_OK) return connection.inputStream.use { it.readBytes() }
                if (code != HttpURLConnection.HTTP_NOT_FOUND) {
                    Log.w(TAG, "the server answered $code for $url")
                    return null
                }
            } catch (err: Exception) {
                Log.w(TAG, "could not fetch $url: $err")
                return null
            } finally {
                connection.disconnect()
            }
            Thread.sleep(FETCH_RETRY_MS)
        }
        return null
    }

    private fun forgetPicture() {
        pictureFree(picture)
        picture = 0L
        pictureUrl = null
    }

    // Fitted inside the page's stage as the page fits it, and drawn at the display's own pixels
    // rather than the page's, up to the picture's.
    private fun place(mine: Int, args: StageShowArgs, width: Int, height: Int) {
        val scale = minOf(args.width.toFloat() / width, args.height.toFloat() / height)
        val fittedWidth = (width * scale).roundToInt().coerceAtLeast(1)
        val fittedHeight = (height * scale).roundToInt().coerceAtLeast(1)
        val shown = ensureView()
        val params = FrameLayout.LayoutParams(fittedWidth, fittedHeight)
        params.leftMargin = args.left + (args.width - fittedWidth) / 2
        params.topMargin = args.top + (args.height - fittedHeight) / 2
        shown.layoutParams = params
        @Suppress("DEPRECATION")
        val mode = activity.windowManager.defaultDisplay.mode
        val pageWidth = activity.window.decorView.width.coerceAtLeast(1)
        val density = maxOf(1f, mode.physicalWidth.toFloat() / pageWidth)
        val bufferWidth = minOf(width, (fittedWidth * density).roundToInt())
        val bufferHeight = minOf(height, (fittedHeight * density).roundToInt())
        shown.holder.setFixedSize(bufferWidth, bufferHeight)
        target = Target(mine, bufferWidth, bufferHeight, args.headroom, args.white)
        placedUrl = args.url
        shown.visibility = View.VISIBLE
        work(mine) { draw() }
    }

    // Waits for `surfaceChanged` where the window is not yet the size the target asks for.
    private fun draw() {
        val target = target ?: return
        val drawn = synchronized(drawing) {
            if (windowWidth != target.width || windowHeight != target.height || picture == 0L) return
            val at = surface ?: return
            if (window == 0L) window = attach(at, windowWidth, windowHeight)
            window != 0L &&
                present(window, picture, windowWidth, windowHeight, target.headroom, target.white)
        }
        activity.runOnUiThread { if (target.ticket == ticket) answer(drawn) }
    }

    private fun answer(drawn: Boolean) {
        waiting?.resolve(shown(drawn))
        waiting = null
    }

    private fun shown(drawn: Boolean) = JSObject().apply { put("drawn", drawn) }

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
                    work(ticket) { draw() }
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
        private const val FETCH_ATTEMPTS = 120
        private const val FETCH_RETRY_MS = 1000L
        private const val FETCH_TIMEOUT_MS = 10_000

        // `stage.rs`, in the app's own library, which the activity has loaded.
        @JvmStatic external fun attach(surface: Surface, width: Int, height: Int): Long

        @JvmStatic external fun detach(window: Long)

        @JvmStatic external fun picture(avif: ByteArray, size: IntArray): Long

        @JvmStatic external fun pictureFree(picture: Long)

        @JvmStatic external fun present(
            window: Long,
            picture: Long,
            width: Int,
            height: Int,
            headroom: Float,
            white: Float,
        ): Boolean
    }
}
