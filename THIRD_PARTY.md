# Third-party notices

Bowerbird itself is MIT (`LICENSE`). This file covers the C libraries that are linked into
the shipped binaries, which is the only place a licence other than MIT reaches a user.

Rust and TypeScript dependencies are not listed here: they are resolved from `Cargo.lock`
and `bun.lock`, and none is copyleft.

## LibRaw 0.21.4

The RAW decoder, in every build: the server, the desktop shells and the Android app.

Upstream: <https://www.libraw.org/>, source <https://github.com/LibRaw/LibRaw>

LibRaw is triple-licensed: LGPL-2.1, CDDL-1.0, or a commercial licence. **Bowerbird elects
CDDL-1.0.**

That election is what permits the static linking the macOS and Android builds do. CDDL
obligations attach to "Modifications" of the Covered Software, and Bowerbird makes none. LibRaw is used unmodified, as built by MacPorts (macOS), Termux (Android), MSYS2 (Windows)
and Debian (`libraw23t64`, the server image). CDDL is file-scoped, so linking it into a
larger work leaves that larger work under its own terms, and Bowerbird stays MIT. There is
no relink obligation of the kind LGPL static linking would carry.

The CDDL-1.0 text ships with LibRaw's own source, at `LICENSE.CDDL` in the distribution
linked above.

### Where it is linked, and how

| build | LibRaw | why |
| --- | --- | --- |
| server (Docker) | dynamic, Debian `libraw23t64` | apt keeps patching LibRaw CVEs |
| macOS `.app` | **static**, MacPorts arm64 | see below |
| Android APK | **static**, Termux aarch64 | an APK ships no prefix to resolve a `.so` against |
| Windows folder | dynamic, MSYS2 `libraw-25.dll` | shipped beside the exe |

macOS is static for a reason that is not size. The linker ad-hoc signs the binary, and the
bundle used to be patched afterwards with `install_name_tool` to repoint `/opt/local/lib/*`
at `@executable_path/../Frameworks`. That rewrites load commands, which live in page 0 of
`__TEXT`, so code directory slot 0 stops matching the file, and arm64 macOS validates every
page as it is paged in, so the kernel killed the process before any app code ran. Linking
the archive leaves nothing to patch.

Its dependencies come with it there: **libjpeg** (IJG licence, permissive) and **Little-CMS
2** (MIT), both as the MacPorts static archives, plus **zlib** (zlib licence). GNU libiconv
is *not* bundled; it is LGPL, and macOS provides one as a system library, which is what the
build links.

## lensfun and libavif

Server only. `rawshim`'s `renditions` feature links **lensfun** (LGPL-3 library, CC BY-SA
3.0 database) and **libavif** (BSD-2-Clause). Both are dynamic system packages in the Docker
image, so the LGPL relink freedom is preserved by construction.

Neither reaches a desktop or mobile build: those link `rawshim` with
`default-features = false`, which is LibRaw and Rust alone.
