import { mergeConfig } from 'vite';
import base from '../vite.config';

// One optimised-dependency cache per worker's server. Shared, a server that finds a dependency
// late rewrites it, and the other server's next request into it answers 504 Outdated Optimize Dep.
export default mergeConfig(base, { cacheDir: process.env.E2E_VITE_CACHE_DIR });
