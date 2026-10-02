set(VCPKG_TARGET_ARCHITECTURE arm64)
set(VCPKG_CRT_LINKAGE static)
set(VCPKG_LIBRARY_LINKAGE static)

set(VCPKG_CMAKE_SYSTEM_NAME Android)
# The app's `minSdk` (`scripts/android-ndk.ts`).
set(VCPKG_CMAKE_SYSTEM_VERSION 24)
set(VCPKG_MAKE_BUILD_TRIPLET "--host=aarch64-linux-android")
# The NDK's libc++ linked in rather than shipped as `libc++_shared.so` beside `librawshim`.
set(VCPKG_CMAKE_CONFIGURE_OPTIONS -DANDROID_ABI=arm64-v8a -DANDROID_STL=c++_static)

set(VCPKG_BUILD_TYPE release)
