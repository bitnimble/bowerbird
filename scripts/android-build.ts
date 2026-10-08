// Build the Android APK, and with `--play` the Play Store's AAB, unsigned; `release.yml` signs both.
//
// The app starts its own server as the desktop does (`src-tauri/src/android.rs`), so this builds
// everything that server runs on for the phone first: the codecs, `librawshim`, and Bun with its
// two native addons (`get:android-runtime`). `bun run build:android` runs this after the steps
// every app shares.
//
// One-time host prereqs: `rustup target add aarch64-linux-android`, an Android SDK with the
// NDK `.android-ndk-version` names, and a JDK 17.
import { spawnSync } from 'node:child_process';
import { ensureIcons, writeAndroidIcons } from './make-icons.ts';
import { VERSION } from '../src/version.ts';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ANDROID_PAGE_SIZE, ANDROID_TARGET, androidNdk } from './android-ndk.ts';

let ndk: ReturnType<typeof androidNdk>;
try {
  ndk = androidNdk();
} catch (missing) {
  console.error(`[android-build] ${(missing as Error).message}`);
  process.exit(1);
}
const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  ...ndk.env,
};

function run(command: string, args: string[], cwd = repoRoot, extra = {}): void {
  const done = spawnSync(command, args, { stdio: 'inherit', env: { ...env, ...extra }, cwd });
  if (done.status !== 0) process.exit(done.status ?? 1);
}

ensureIcons();

// The Gradle project, on the same terms as the icons: it bakes in this machine's SDK paths, so it
// is generated rather than committed and a fresh checkout has none.
const repoRoot = resolve(import.meta.dir, '..');
if (!existsSync(join(repoRoot, 'src-tauri', 'gen', 'android'))) {
  run('bun', ['x', '@tauri-apps/cli', 'android', 'init']);
}
patchProject(join(repoRoot, 'src-tauri', 'gen', 'android', 'app'));

run('bun', ['run', 'get:codecs', '--target', ANDROID_TARGET]);
run('bun', ['run', 'build:native:release', '--target', ANDROID_TARGET], repoRoot, {
  CARGO_PROFILE_RELEASE_STRIP: 'symbols',
});
run('bun', ['run', 'get:android-runtime']);
// The page the server serves and the server itself, which `tauri.android.conf.json` embeds as the
// app's assets.
run('bun', ['run', 'build'], join(repoRoot, 'web'));
run('bun', ['run', 'scripts/build-sidecar.ts', '--target', ANDROID_TARGET]);

const play = process.argv.includes('--play');
const passed = process.argv.slice(2).filter((arg) => arg !== '--play');
const tauriBuild = (format: '--apk' | '--aab', extra = {}): void =>
  run(
    'bun',
    [
      'x',
      '@tauri-apps/cli',
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
tauriBuild('--apk');
// Play forbids an app updating itself other than through Play, so its build checks for none.
if (play) tauriBuild('--aab', { BOWERBIRD_UPDATE_URL: '' });

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
    writeFileSync(gradlePath, gradle);
  }

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
  const manifest = readFileSync(manifestPath, 'utf8');
  const named = 'android:networkSecurityConfig="@xml/network_security_config"';
  if (!manifest.includes(named)) {
    if (!manifest.includes('<application')) {
      throw new Error(`${manifestPath} has no \`<application>\` to patch`);
    }
    writeFileSync(manifestPath, manifest.replace('<application', `<application\n        ${named}`));
  }

  // Edge to edge, as Tauri's template asks for, draws the page under the status and navigation
  // bars, and the WebView reports none of them to CSS; so the page is inset natively instead.
  const activity = findFile(join(app, 'src', 'main', 'java'), 'MainActivity.kt');
  if (activity == null) throw new Error(`no MainActivity.kt under ${app}`);
  const pkg = /^package .+$/m.exec(readFileSync(activity, 'utf8'))?.[0];
  if (pkg == null) throw new Error(`${activity} names no package`);
  writeFileSync(
    activity,
    `${pkg}

import android.content.pm.ActivityInfo
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
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
  }

  // Off, the WebView ignores the page's viewport tag, which is how its interface scale applies.
  override fun onWebViewCreate(webView: WebView) {
    webView.settings.useWideViewPort = true
  }
}
`,
  );
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

// One APK, chosen rather than whichever the walk reached last: nothing cleans this tree, so it
// holds whatever earlier builds left in it.
//
// Chosen by build type, not by the word "unsigned". Nothing here configures signing, so the
// release APK this produces IS `app-universal-release-unsigned.apk` - filtering that word
// out selects a debug APK from an earlier `tauri android dev` instead, leaves exactly one
// candidate so the check below stays quiet, and ships it.
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
if (dist) {
  mkdirSync(resolve(dist), { recursive: true });
  const out = join(resolve(dist), 'Bowerbird.apk');
  signWithDebugKey(apk, out);
  console.error(`[android-build] apk, signed with the debug key: ${out}`);
} else {
  console.error(`[android-build] apk: ${apk}`);
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
