import { expect, test } from 'bun:test';

import { elfClosure, machNames } from './native_closure';

// `ldd librawshim.so`: the C++ runtime the app carries, the C library it must not, the loader
// and the vDSO, which are printed with no path at all.
const ELF = `
	linux-vdso.so.1 (0x00007f808bce8000)
	libstdc++.so.6 => /usr/lib/x86_64-linux-gnu/libstdc++.so.6 (0x00007f8088ed0000)
	libm.so.6 => /usr/lib/x86_64-linux-gnu/libm.so.6 (0x00007f8088de7000)
	libgcc_s.so.1 => /usr/lib/x86_64-linux-gnu/libgcc_s.so.1 (0x00007f8088db9000)
	libc.so.6 => /usr/lib/x86_64-linux-gnu/libc.so.6 (0x00007f8088ba6000)
	/lib64/ld-linux-x86-64.so.2 (0x00007f808bcea000)
`;

test('an elf closure carries the C++ runtime but never the C library or the loader', () => {
  expect(elfClosure(ELF)).toEqual([
    '/usr/lib/x86_64-linux-gnu/libstdc++.so.6',
    '/usr/lib/x86_64-linux-gnu/libgcc_s.so.1',
  ]);
});

test('an elf closure refuses a dependency the loader could not place', () => {
  expect(() => elfClosure('\tlibmissing.so.4 => not found\n')).toThrow('could not be placed');
});

// `otool -L librawshim.dylib` from a build against Homebrew's codecs, which is what the check
// refuses: its own install name, two libraries by path, one relative to a search path, and the two
// macOS owns.
const MACH = `resources/librawshim.dylib:
	@rpath/librawshim.dylib (compatibility version 0.0.0, current version 0.0.0)
	/opt/homebrew/opt/aom/lib/libaom.3.dylib (compatibility version 1.0.0, current version 1.0.0)
	/opt/homebrew/opt/dav1d/lib/libdav1d.7.dylib (compatibility version 1.0.0, current version 8401.0.0)
	@rpath/libunplaceable.dylib (compatibility version 1.0.0, current version 1.0.0)
	/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1345.0.0)
	/usr/lib/libc++.1.dylib (compatibility version 1.0.0, current version 1800.0.0)
`;

test('mach names are what a reader would have to supply, never what the OS owns or its own install name', () => {
  expect(machNames(MACH, 'librawshim.dylib')).toEqual([
    '/opt/homebrew/opt/aom/lib/libaom.3.dylib',
    '/opt/homebrew/opt/dav1d/lib/libdav1d.7.dylib',
    '@rpath/libunplaceable.dylib',
  ]);
});

