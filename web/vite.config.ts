import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API is a separate service on its own origin (CORS_ORIGINS must list this
// dev server). VITE_API_URL points the client at it; see src/api/client.ts.
export default defineConfig({
  plugins: [react()],
  // Standard decorators are stage 3, so they must be lowered before Rollup sees
  // them: at target esnext esbuild passes `accessor` through and the build fails
  // to parse.
  esbuild: { target: 'es2022' },
  build: { target: 'es2022' },
  server: {
    port: 5174,
    strictPort: true,
    host: true,
  },
});
