// What this build calls itself, which is what an update check compares against.
//
// Imported rather than read at startup because the sidecar ships as a bundle with no
// `VERSION` beside it, and `bun build` inlines a text import.
import version from '../VERSION' with { type: 'text' };

export const VERSION: string = version.trim();
