set(VCPKG_TARGET_ARCHITECTURE arm64)
set(VCPKG_CRT_LINKAGE dynamic)
set(VCPKG_LIBRARY_LINKAGE static)

set(VCPKG_CMAKE_SYSTEM_NAME Darwin)
set(VCPKG_OSX_ARCHITECTURES arm64)

set(VCPKG_BUILD_TYPE release)
# Rust's own floor for aarch64-apple-darwin, which is what the app ships at. Left unset, vcpkg
# builds for whatever macOS the build machine runs, and a codec may then call something a reader
# on an older release does not have.
set(VCPKG_OSX_DEPLOYMENT_TARGET 11.0)
