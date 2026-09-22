import { expect, test } from 'bun:test';

import { elfClosure, machClosure, machNames, peClosure } from './native_closure';

// `ldd librawshim.so`, trimmed: what the app carries, the C library it must not, the loader
// and the vDSO, which are printed with no path at all.
const ELF = `
	linux-vdso.so.1 (0x00007f3935e4c000)
	liblensfun.so.1 => /usr/lib/x86_64-linux-gnu/liblensfun.so.1 (0x00007f393407d000)
	libglib-2.0.so.0 => /usr/lib/x86_64-linux-gnu/libglib-2.0.so.0 (0x00007f393311a000)
	libaom.so.3 => /usr/lib/x86_64-linux-gnu/libaom.so.3 (0x00007f3933aff000)
	libstdc++.so.6 => /usr/lib/x86_64-linux-gnu/libstdc++.so.6 (0x00007f393358e000)
	libgcc_s.so.1 => /usr/lib/x86_64-linux-gnu/libgcc_s.so.1 (0x00007f3933560000)
	libc.so.6 => /usr/lib/x86_64-linux-gnu/libc.so.6 (0x00007f3933265000)
	libm.so.6 => /usr/lib/x86_64-linux-gnu/libm.so.6 (0x00007f3933477000)
	/lib64/ld-linux-x86-64.so.2 (0x00007f3935e4e000)
`;

test('an elf closure carries the libraries but never the C library or the loader', () => {
  expect(elfClosure(ELF)).toEqual([
    '/usr/lib/x86_64-linux-gnu/liblensfun.so.1',
    '/usr/lib/x86_64-linux-gnu/libglib-2.0.so.0',
    '/usr/lib/x86_64-linux-gnu/libaom.so.3',
    '/usr/lib/x86_64-linux-gnu/libstdc++.so.6',
    '/usr/lib/x86_64-linux-gnu/libgcc_s.so.1',
  ]);
});

// An `ldd rawshim.dll` in an MSYS2 CLANG64 shell: what the tree provides, what Windows
// provides, a name nothing could place, and one printed without a load address.
const PE = `
        ntdll.dll => /c/WINDOWS/SYSTEM32/ntdll.dll (0x7ffdc4a10000)
        KERNEL32.DLL => /c/WINDOWS/System32/KERNEL32.DLL (0x7ffdc3a00000)
        liblensfun.dll => /clang64/bin/liblensfun.dll (0x7ffd90000000)
        libglib-2.0-0.dll => /clang64/bin/libglib-2.0-0.dll (0x7ffd8f000000)
        libunwind.dll => /clang64/bin/libunwind.dll
        libc++.dll => /clang64/bin/libc++.dll (0x7FFD8E000000)
`;

test('a pe closure is what resolved under the prefix, addresses and all else dropped', () => {
  expect(peClosure(PE, '/clang64')).toEqual([
    '/clang64/bin/liblensfun.dll',
    '/clang64/bin/libglib-2.0-0.dll',
    '/clang64/bin/libunwind.dll',
    '/clang64/bin/libc++.dll',
  ]);
});

test('a sibling environment is not the prefix, so nothing of it is carried', () => {
  expect(peClosure(PE, '/ucrt64')).toEqual([]);
});

// `ldd` exits 0 on one of these, so the refusal is the only thing that sees it.
test.each([
  ['an elf', (walk: string) => elfClosure(walk)],
  ['a pe', (walk: string) => peClosure(walk, '/clang64')],
])('%s closure refuses a dependency the loader could not place', (_name, closure) => {
  expect(() => closure('\tlibmissing.so.4 => not found\n')).toThrow('could not be placed');
});

test('a pe closure refuses the MSYS runtime, which is a build against the wrong environment', () => {
  expect(() => peClosure('\tmsys-2.0.dll => /usr/bin/msys-2.0.dll (0x210000000)\n', '/clang64')).toThrow(
    'MSYS runtime',
  );
});

// `otool -L librawshim.dylib`: the file being read, its own install name, what it needs, and a
// name Homebrew left relative because it could not place the file.
const MACH = `resources/librawshim.dylib:
	@rpath/librawshim.dylib (compatibility version 0.0.0, current version 0.0.0)
	/opt/homebrew/opt/lensfun/lib/liblensfun.1.dylib (compatibility version 1.0.0, current version 1.0.0)
	/opt/homebrew/opt/glib/lib/libglib-2.0.0.dylib (compatibility version 1.0.0, current version 8401.0.0)
	@rpath/libunplaceable.dylib (compatibility version 1.0.0, current version 1.0.0)
	/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1345.0.0)
	/usr/lib/libc++.1.dylib (compatibility version 1.0.0, current version 1800.0.0)
`;

test('a mach closure is what brew put there, never what the OS owns or its own install name', () => {
  expect(machClosure(MACH, 'librawshim.dylib')).toEqual([
    '/opt/homebrew/opt/lensfun/lib/liblensfun.1.dylib',
    '/opt/homebrew/opt/glib/lib/libglib-2.0.0.dylib',
  ]);
});

test('a name left relative is reported, being what nothing would otherwise carry', () => {
  expect(machNames(MACH, 'librawshim.dylib')).toContain('@rpath/libunplaceable.dylib');
});
