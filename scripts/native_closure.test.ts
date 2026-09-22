import { expect, test } from 'bun:test';

import { elfClosure, machNames, machSearchPath } from './native_closure';

// `ldd librawshim.so`, trimmed: what the app carries, the C library it must not, the loader
// and the vDSO, which are printed with no path at all.
const ELF = `
	linux-vdso.so.1 (0x00007f3935e4c000)
	libaom.so.3 => /usr/lib/x86_64-linux-gnu/libaom.so.3 (0x00007f393407d000)
	libdav1d.so.7 => /usr/lib/x86_64-linux-gnu/libdav1d.so.7 (0x00007f393311a000)
	libsharpyuv.so.0 => /usr/lib/x86_64-linux-gnu/libsharpyuv.so.0 (0x00007f3933aff000)
	libstdc++.so.6 => /usr/lib/x86_64-linux-gnu/libstdc++.so.6 (0x00007f393358e000)
	libgcc_s.so.1 => /usr/lib/x86_64-linux-gnu/libgcc_s.so.1 (0x00007f3933560000)
	libc.so.6 => /usr/lib/x86_64-linux-gnu/libc.so.6 (0x00007f3933265000)
	libm.so.6 => /usr/lib/x86_64-linux-gnu/libm.so.6 (0x00007f3933477000)
	/lib64/ld-linux-x86-64.so.2 (0x00007f3935e4e000)
`;

test('an elf closure carries the libraries but never the C library or the loader', () => {
  expect(elfClosure(ELF)).toEqual([
    '/usr/lib/x86_64-linux-gnu/libaom.so.3',
    '/usr/lib/x86_64-linux-gnu/libdav1d.so.7',
    '/usr/lib/x86_64-linux-gnu/libsharpyuv.so.0',
    '/usr/lib/x86_64-linux-gnu/libstdc++.so.6',
    '/usr/lib/x86_64-linux-gnu/libgcc_s.so.1',
  ]);
});

test('an elf closure refuses a dependency the loader could not place', () => {
  expect(() => elfClosure('\tlibmissing.so.4 => not found\n')).toThrow('could not be placed');
});

// `otool -L librawshim.dylib`: the file being read, its own install name, what it needs, and a
// name Homebrew left relative because it could not place the file.
const MACH = `resources/librawshim.dylib:
	@rpath/librawshim.dylib (compatibility version 0.0.0, current version 0.0.0)
	/opt/homebrew/opt/aom/lib/libaom.3.dylib (compatibility version 1.0.0, current version 1.0.0)
	/opt/homebrew/opt/dav1d/lib/libdav1d.7.dylib (compatibility version 1.0.0, current version 8401.0.0)
	@rpath/libunplaceable.dylib (compatibility version 1.0.0, current version 1.0.0)
	/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1345.0.0)
	/usr/lib/libc++.1.dylib (compatibility version 1.0.0, current version 1800.0.0)
`;

test('mach names are what brew put there, never what the OS owns or its own install name', () => {
  expect(machNames(MACH, 'librawshim.dylib')).toEqual([
    '/opt/homebrew/opt/aom/lib/libaom.3.dylib',
    '/opt/homebrew/opt/dav1d/lib/libdav1d.7.dylib',
    '@rpath/libunplaceable.dylib',
  ]);
});

// `otool -l libbrotlienc.1.dylib`, trimmed to the two load commands that say anything here.
const LOAD_COMMANDS = `Load command 12
          cmd LC_LOAD_DYLIB
      cmdsize 72
         name @rpath/libbrotlicommon.1.dylib (offset 24)
Load command 15
          cmd LC_RPATH
      cmdsize 40
         path /opt/homebrew/opt/brotli/lib (offset 12)
Load command 16
          cmd LC_RPATH
      cmdsize 32
         path @loader_path/../lib (offset 12)
`;

test('a mach search path is every rpath the library carries, in order', () => {
  expect(machSearchPath(LOAD_COMMANDS)).toEqual([
    '/opt/homebrew/opt/brotli/lib',
    '@loader_path/../lib',
  ]);
});

test('a library with no rpath searches nowhere', () => {
  expect(machSearchPath('Load command 1\n          cmd LC_SEGMENT_64\n')).toEqual([]);
});
