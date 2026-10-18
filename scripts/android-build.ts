// Build the Android APK, and with `--play` the Play Store's AAB, unsigned; `release.yml` signs both.
// `--dev` instead builds `photos.bowerbird.dev`, labelled "Bowerbird dev" and signed with the debug
// key, which installs beside the release app.
//
// The app starts its own server as the desktop does (`src-tauri/src/android.rs`), so this builds
// everything that server runs on for the phone first: the codecs, `librawshim`, Bun with its two
// native addons (`get:android-runtime`), and the library Bun is preloaded with (`seccomp_enosys`).
// `bun run build:android` runs this after the steps every app shares.
//
// One-time host prereqs: `rustup target add aarch64-linux-android`, an Android SDK with the
// NDK `.android-ndk-version` names, and a JDK 17.
import { spawnSync } from 'node:child_process';
import { cli } from './get-tauri-cli.ts';
import { ensureIcons, writeAndroidIcons } from './make-icons.ts';
import { VERSION } from '../src/version.ts';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { ANDROID_PAGE_SIZE, ANDROID_TARGET, androidNdk, type AndroidNdk } from './android-ndk.ts';
import { TV_AGENT, TV_BACK } from '../web/src/app/tv.ts';

let ndk: AndroidNdk;
let tauri: string;
try {
  ndk = androidNdk();
  tauri = cli();
} catch (missing) {
  console.error(`[android-build] ${(missing as Error).message}`);
  process.exit(1);
}
const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  ...ndk.env,
  // `tauri android init` has Gradle call back into the CLI as `cargo tauri`.
  PATH: `${dirname(tauri)}${delimiter}${process.env.PATH ?? ''}`,
};

function run(
  command: string,
  args: string[],
  cwd = repoRoot,
  extra: Record<string, string> = {},
): void {
  const done = spawnSync(command, args, { stdio: 'inherit', env: { ...env, ...extra }, cwd });
  if (done.status !== 0) process.exit(done.status ?? 1);
}

const DEV_ID_SUFFIX = '.dev';
const MEDIA_PERMISSIONS = [
  '<uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />',
  '<uses-permission android:name="android.permission.READ_MEDIA_VISUAL_USER_SELECTED" />',
  '<uses-permission android:name="android.permission.ACCESS_MEDIA_LOCATION" />',
  // A special app access the reader turns on in system settings, which lint takes for a system app's.
  '<uses-permission android:name="android.permission.MANAGE_MEDIA" tools:ignore="ProtectedPermissions" />',
  '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />',
  '<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29" />',
];
// Play hides an app from TVs unless touchscreen is optional.
const FEATURES = [
  '<uses-feature android:name="android.software.leanback" android:required="false" />',
  '<uses-feature android:name="android.hardware.touchscreen" android:required="false" />',
];
const LAUNCHER = '<category android:name="android.intent.category.LAUNCHER" />';
const TV_LAUNCHER = '<category android:name="android.intent.category.LEANBACK_LAUNCHER" />';

const play = process.argv.includes('--play');
const dev = process.argv.includes('--dev');
const passed = process.argv.slice(2).filter((arg) => arg !== '--play' && arg !== '--dev');
if (dev && play) {
  console.error('[android-build] --dev builds a sideloaded app, which Play has no listing for');
  process.exit(1);
}

ensureIcons();

// The Gradle project, on the same terms as the icons: it bakes in this machine's SDK paths, so it
// is generated rather than committed and a fresh checkout has none.
const repoRoot = resolve(import.meta.dir, '..');
if (!existsSync(join(repoRoot, 'src-tauri', 'gen', 'android'))) {
  run(tauri, ['android', 'init']);
}
patchProject(join(repoRoot, 'src-tauri', 'gen', 'android', 'app'));

run('bun', ['run', 'get:codecs', '--target', ANDROID_TARGET]);
run('bun', ['run', 'build:native:release', '--target', ANDROID_TARGET], repoRoot, {
  CARGO_PROFILE_RELEASE_STRIP: 'symbols',
});
run('bun', [
  'run',
  'scripts/cargo.ts',
  'build',
  '--release',
  '--manifest-path',
  'native/seccomp_enosys/Cargo.toml',
  '--target',
  ANDROID_TARGET,
]);
run('bun', ['run', 'get:android-runtime']);
// The page the server serves and the server itself, which `tauri.android.conf.json` embeds as the
// app's assets.
run('bun', ['run', 'build'], join(repoRoot, 'web'));
run('bun', ['run', 'scripts/build-sidecar.ts', '--target', ANDROID_TARGET]);

const tauriBuild = (format: '--apk' | '--aab', extra: Record<string, string> = {}): void =>
  run(
    tauri,
    [
      'android',
      'build',
      '--target',
      'aarch64',
      format,
      '--config',
      JSON.stringify({ version: VERSION }),
      ...passed,
    ],
    repoRoot,
    extra,
  );
// Play forbids an app updating itself other than through Play, so its build checks for none; a dev
// build's update would be the release app, a different package installed beside it.
const noUpdates = { BOWERBIRD_UPDATE_URL: '' };
tauriBuild('--apk', dev ? noUpdates : {});
if (play) tauriBuild('--aab', noUpdates);

/**
 * What the generated project gets wrong for an app whose page is its own local server's.
 *
 * Release builds refuse cleartext, and the page is `http://127.0.0.1`, so cleartext is allowed to
 * that address and no other. And the runtime and the addons run from the native library
 * directory, which the installer only fills when the APK's libraries are packaged to be extracted
 * rather than mapped from the archive.
 */
function patchProject(app: string): void {
  // `tauri android init` fills these with Tauri's own icon.
  writeAndroidIcons(join(app, 'src', 'main', 'res'));

  const gradlePath = join(app, 'build.gradle.kts');
  let gradle = readFileSync(gradlePath, 'utf8');
  const extracted = 'packaging { jniLibs.useLegacyPackaging = true }';
  if (!gradle.includes(extracted)) {
    const anchor = '    buildFeatures {';
    if (!gradle.includes(anchor)) {
      throw new Error(`${gradlePath} has no \`buildFeatures\` to patch beside`);
    }
    gradle = gradle.replace(anchor, `    ${extracted}\n${anchor}`);
  }
  const suffix = `        applicationIdSuffix = "${DEV_ID_SUFFIX}"\n`;
  gradle = gradle.replace(suffix, '');
  if (dev) {
    const applicationId = /^ *applicationId = .+\n/m;
    if (!applicationId.test(gradle)) throw new Error(`${gradlePath} has no \`applicationId\``);
    gradle = gradle.replace(applicationId, (line) => `${line}${suffix}`);
  }
  writeFileSync(gradlePath, gradle);

  const label = dev ? 'Bowerbird dev' : 'Bowerbird';
  writeFileSync(
    join(app, 'src', 'main', 'res', 'values', 'strings.xml'),
    [
      '<resources>',
      `    <string name="app_name">"${label}"</string>`,
      `    <string name="main_activity_title">"${label}"</string>`,
      '</resources>',
      '',
    ].join('\n'),
  );

  const xml = join(app, 'src', 'main', 'res', 'xml');
  mkdirSync(xml, { recursive: true });
  writeFileSync(
    join(xml, 'network_security_config.xml'),
    [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<network-security-config>',
      '    <domain-config cleartextTrafficPermitted="true">',
      '        <domain includeSubdomains="false">127.0.0.1</domain>',
      '    </domain-config>',
      '</network-security-config>',
      '',
    ].join('\n'),
  );
  const manifestPath = join(app, 'src', 'main', 'AndroidManifest.xml');
  let manifest = readFileSync(manifestPath, 'utf8');
  const root = '<manifest xmlns:android="http://schemas.android.com/apk/res/android"';
  if (!manifest.includes('<application') || !manifest.includes(root)) {
    throw new Error(`${manifestPath} has no \`<manifest>\` and \`<application>\` to patch`);
  }
  const tools = 'xmlns:tools="http://schemas.android.com/tools"';
  if (!manifest.includes(tools)) manifest = manifest.replace(root, `${root}\n    ${tools}`);
  for (const attribute of [
    'android:networkSecurityConfig="@xml/network_security_config"',
    // Android 10 opens shared storage by path only with the legacy flag (`PhotosPlugin.kt`).
    'android:requestLegacyExternalStorage="true"',
    'android:banner="@drawable/tv_banner"',
  ]) {
    if (!manifest.includes(attribute)) {
      manifest = manifest.replace('<application', `<application\n        ${attribute}`);
    }
  }
  for (const declaration of [...MEDIA_PERMISSIONS, ...FEATURES]) {
    if (!manifest.includes(declaration)) {
      manifest = manifest.replace('<application', `${declaration}\n    <application`);
    }
  }
  if (!manifest.includes(TV_LAUNCHER)) {
    if (!manifest.includes(LAUNCHER)) throw new Error(`${manifestPath} has no launcher category`);
    manifest = manifest.replace(LAUNCHER, `${LAUNCHER}\n                ${TV_LAUNCHER}`);
  }
  writeFileSync(manifestPath, manifest);

  // Edge to edge, as Tauri's template asks for, draws the page under the status and navigation
  // bars, and the WebView reports none of them to CSS; so the page is inset natively instead.
  const activity = findFile(join(app, 'src', 'main', 'java'), 'MainActivity.kt');
  if (activity == null) throw new Error(`no MainActivity.kt under ${app}`);
  const pkg = /^package .+$/m.exec(readFileSync(activity, 'utf8'))?.[0];
  if (pkg == null) throw new Error(`${activity} names no package`);
  writeFileSync(
    activity,
    `${pkg}

import android.app.UiModeManager
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private val onTv by lazy {
    getSystemService(UiModeManager::class.java).currentModeType ==
      Configuration.UI_MODE_TYPE_TELEVISION
  }
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
    )
    super.onCreate(savedInstanceState)
    // Chrome switches its own window to HDR; a WebView draws HDR only in a window its app has.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      window.colorMode = ActivityInfo.COLOR_MODE_HDR
    }
    val content = findViewById<View>(android.R.id.content)
    // \`ink\` in web/src/ui/tokens.stylex.ts, the page's own background.
    content.setBackgroundColor(Color.parseColor("#14161a"))
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or
          WindowInsetsCompat.Type.displayCutout() or
          WindowInsetsCompat.Type.ime(),
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
    // A callback, not \`onBackPressed\`: targeting API 36, Android 16 never calls that override.
    // Backgrounded, not finished: Tauri's result launchers stay bound to the first activity, so
    // after a finish \`PhotosPlugin.kt\`'s prompts never answer.
    onBackPressedDispatcher.addCallback(this, backCallback { moveTaskToBack(true) })
  }

  // Off, the WebView ignores the page's viewport tag, which is how its interface scale applies.
  override fun onWebViewCreate(webView: WebView) {
    webView.settings.useWideViewPort = true
    // The page's tag only says user-scalable=no once a UI scale has rewritten it.
    webView.settings.setSupportZoom(false)
    if (onTv) {
      webView.settings.userAgentString = webView.settings.userAgentString + " ${TV_AGENT}"
      // The D-pad's keys go to the focused view, and nothing else in the window takes focus.
      webView.requestFocus()
      // Over \`StagePlugin.kt\`'s HDR stage, which the page shows through.
      webView.setBackgroundColor(Color.TRANSPARENT)
      // Here, not in onCreate: the newest callback runs first, and Tauri's AppPlugin, loaded
      // before the WebView, adds one stepping its history back a photo.
      onBackPressedDispatcher.addCallback(
        this,
        backCallback {
          webView.evaluateJavascript("window.${TV_BACK}?.() === true") { handled ->
            if (handled != "true") moveTaskToBack(true)
          }
        },
      )
    }
  }

  private fun backCallback(back: () -> Unit) =
    object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() = back()
    }
}
`,
  );

  const plugins = join(repoRoot, 'src-tauri', 'android');
  const sources = readdirSync(plugins).filter((file) => file.endsWith('.kt'));
  // The generated project outlives the tree, so a deleted plugin would stay compiled into the app.
  for (const copied of readdirSync(dirname(activity))) {
    if (copied.endsWith('.kt') && copied !== 'MainActivity.kt' && !sources.includes(copied)) {
      rmSync(join(dirname(activity), copied));
    }
  }
  for (const name of sources) {
    const plugin = readFileSync(join(plugins, name), 'utf8');
    writeFileSync(join(dirname(activity), name), plugin.replace(/^package .+$/m, pkg));
  }
}

function findFile(dir: string, name: string): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const found = findFile(path, name);
      if (found != null) return found;
    }
  }
  return null;
}

// Gradle leaves the APK under the generated project; copy it somewhere a phone can reach.
const outputs = join(repoRoot, 'src-tauri', 'gen', 'android', 'app', 'build', 'outputs', 'apk');
const found: string[] = [];
const walk = (dir: string): void => {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith('.apk')) found.push(path);
  }
};
walk(outputs);
if (found.length === 0) {
  console.error(`[android-build] built, but no APK under ${outputs}`);
  process.exit(1);
}

// By build type, never the word "unsigned": the release APK is `...-release-unsigned.apk`, and
// nothing cleans the older debug APKs out of this tree.
const release = found.filter((apk) => /[/\\]release[/\\]/.test(apk));
const chosen = release.length > 0 ? release : found;
if (chosen.length > 1) {
  console.error(
    `[android-build] ${chosen.length} APKs under ${outputs}, so which one ships is ambiguous:`,
  );
  for (const apk of chosen) console.error(`  ${apk}`);
  console.error('[android-build] clear the outputs tree and build again');
  process.exit(1);
}

// Empty is unset, not the current directory: `''.trim()` is not null, and `resolve('')` is
// wherever this happens to be running.
const dist = process.env.BOWERBIRD_ANDROID_DIST_DIR?.trim();
const apk = chosen[0]!;
assertPageAligned(apk);
if (play) {
  assertPageAligned(join(outputs, '..', 'bundle', 'universalRelease', 'app-universal-release.aab'));
}
const outDir = dist ? resolve(dist) : dirname(apk);
mkdirSync(outDir, { recursive: true });
if (dev) {
  const out = join(outDir, 'Bowerbird-dev.apk');
  signWithDebugKey(apk, out);
  console.error(`[android-build] apk, signed with the debug key: ${out}`);
} else if (dist) {
  const out = join(outDir, 'Bowerbird-unsigned.apk');
  copyFileSync(apk, out);
  console.error(`[android-build] apk, unsigned: ${out}`);
} else {
  console.error(`[android-build] apk, unsigned: ${apk}`);
}

function assertPageAligned(archive: string): void {
  const scratch = mkdtempSync(join(tmpdir(), 'bb-page-size-'));
  try {
    run('unzip', ['-q', '-o', archive, '*.so', '-d', scratch]);
    const libraries = readdirSync(scratch, { recursive: true, encoding: 'utf8' }).filter((path) =>
      path.endsWith('.so'),
    );
    for (const library of libraries) {
      const readelf = spawnSync(join(ndk.bin, 'llvm-readelf'), ['-lW', join(scratch, library)], {
        encoding: 'utf8',
      });
      const aligns =
        readelf.status === 0
          ? readelf.stdout
              .split('\n')
              .filter((line) => line.trim().startsWith('LOAD'))
              .map((line) => Number(line.trim().split(/\s+/).at(-1)))
          : [];
      if (aligns.length === 0 || aligns.some((align) => !(align >= ANDROID_PAGE_SIZE))) {
        console.error(
          `[android-build] ${library} in ${archive} has LOAD alignments [${aligns.join(', ')}], ` +
            `not all ${ANDROID_PAGE_SIZE} or more${readelf.stderr ? `: ${readelf.stderr}` : ''}`,
        );
        process.exit(1);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The key Android Studio signs debug builds with, made the way it makes it where it is missing. */
function signWithDebugKey(unsigned: string, out: string): void {
  const keystore = join(homedir(), '.android', 'debug.keystore');
  if (!existsSync(keystore)) {
    mkdirSync(dirname(keystore), { recursive: true });
    run('keytool', [
      '-genkeypair',
      '-keystore',
      keystore,
      '-storepass',
      'android',
      '-alias',
      'androiddebugkey',
      '-keypass',
      'android',
      '-keyalg',
      'RSA',
      '-keysize',
      '2048',
      '-validity',
      '10000',
      '-dname',
      'CN=Android Debug,O=Android,C=US',
    ]);
  }
  const tools = join(ndk.env.ANDROID_HOME!, 'build-tools');
  const newest = readdirSync(tools)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .at(-1);
  if (newest == null) throw new Error(`no build-tools under ${tools} to sign with`);
  run(join(tools, newest, 'apksigner'), [
    'sign',
    '--ks',
    keystore,
    '--ks-pass',
    'pass:android',
    '--ks-key-alias',
    'androiddebugkey',
    '--out',
    out,
    unsigned,
  ]);
}
