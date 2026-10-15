package photos.bowerbird

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.Settings
import androidx.activity.result.ActivityResult
import androidx.activity.result.IntentSenderRequest
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class GrantWritesArgs {
    lateinit var paths: List<String>
}

@TauriPlugin
class PhotosPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun access(invoke: Invoke) {
        invoke.resolve(state())
    }

    @Command
    fun requestAccess(invoke: Invoke) {
        handle!!.requestPermissions(invoke, readPermissions(), "accessAnswered")
    }

    @Command
    fun requestManagement(invoke: Invoke) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            invoke.resolve(state())
            return
        }
        startActivityForResult(invoke, appSettings(Settings.ACTION_REQUEST_MANAGE_MEDIA), "settingsAnswered")
    }

    @Command
    fun openSettings(invoke: Invoke) {
        startActivityForResult(invoke, appSettings(Settings.ACTION_APPLICATION_DETAILS_SETTINGS), "settingsAnswered")
    }

    /** Paths the media store doesn't hold are left to the filesystem's own permissions. */
    @Command
    fun grantWrites(invoke: Invoke) {
        val paths = invoke.parseArgs(GrantWritesArgs::class.java).paths
        // Below 11 the legacy storage flag is what writes, and there is nothing to ask.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            if (granted(Manifest.permission.WRITE_EXTERNAL_STORAGE)) {
                invoke.resolve()
            } else {
                invoke.reject("this device has not allowed Bowerbird to change photos")
            }
            return
        }
        val uris = imageUris(paths)
        if (uris.isEmpty()) {
            invoke.resolve()
            return
        }
        // Android drops activity launches from the background, and the request would never answer.
        if (!(activity as LifecycleOwner).lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
            invoke.reject("the app is in the background, so Android can't be asked to change these photos")
            return
        }
        val request = MediaStore.createWriteRequest(activity.contentResolver, uris)
        startIntentSenderForResult(invoke, IntentSenderRequest.Builder(request.intentSender).build(), "writesAnswered")
    }

    @PermissionCallback
    private fun accessAnswered(invoke: Invoke) {
        invoke.resolve(state())
    }

    @ActivityCallback
    private fun settingsAnswered(invoke: Invoke, result: ActivityResult) {
        invoke.resolve(state())
    }

    @ActivityCallback
    private fun writesAnswered(invoke: Invoke, result: ActivityResult) {
        if (result.resultCode == Activity.RESULT_OK) invoke.resolve() else invoke.reject("declined", DECLINED)
    }

    private fun state(): JSObject {
        val all = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            Manifest.permission.READ_MEDIA_IMAGES
        } else {
            Manifest.permission.READ_EXTERNAL_STORAGE
        }
        val photos = when {
            granted(all) -> "all"
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE &&
                granted(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) -> "selected"
            else -> "none"
        }
        return JSObject().apply {
            put("photos", photos)
            put("manageable", Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
            put(
                "managed",
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    MediaStore.canManageMedia(activity)
                } else {
                    Build.VERSION.SDK_INT < Build.VERSION_CODES.R
                },
            )
            put("cameraFolder", Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DCIM).absolutePath)
        }
    }

    private fun readPermissions(): Array<String> = when {
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE -> arrayOf(
            Manifest.permission.READ_MEDIA_IMAGES,
            Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED,
            Manifest.permission.ACCESS_MEDIA_LOCATION,
        )
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU -> arrayOf(
            Manifest.permission.READ_MEDIA_IMAGES,
            Manifest.permission.ACCESS_MEDIA_LOCATION,
        )
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.R -> arrayOf(
            Manifest.permission.READ_EXTERNAL_STORAGE,
            Manifest.permission.ACCESS_MEDIA_LOCATION,
        )
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q -> arrayOf(
            Manifest.permission.READ_EXTERNAL_STORAGE,
            Manifest.permission.WRITE_EXTERNAL_STORAGE,
            Manifest.permission.ACCESS_MEDIA_LOCATION,
        )
        else -> arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE)
    }

    private fun granted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(activity, permission) == PackageManager.PERMISSION_GRANTED

    private fun appSettings(action: String): Intent =
        Intent(action, Uri.fromParts("package", activity.packageName, null))

    // A write request takes only items of a typed collection, never a `Files` row.
    private fun imageUris(paths: List<String>): List<Uri> = paths.chunked(QUERY_CHUNK).flatMap { chunk ->
        val found = mutableListOf<Uri>()
        activity.contentResolver.query(
            MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL),
            arrayOf(
                MediaStore.MediaColumns._ID,
                MediaStore.MediaColumns.VOLUME_NAME,
                MediaStore.Files.FileColumns.MEDIA_TYPE,
            ),
            "${MediaStore.MediaColumns.DATA} IN (${chunk.joinToString(",") { "?" }})",
            chunk.toTypedArray(),
            null,
        )?.use { rows ->
            while (rows.moveToNext()) {
                if (rows.getInt(2) != MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE) continue
                found += MediaStore.Images.Media.getContentUri(rows.getString(1), rows.getLong(0))
            }
        }
        found
    }

    private companion object {
        const val QUERY_CHUNK = 500
        const val DECLINED = "declined"
    }
}
