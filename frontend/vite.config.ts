import { defineConfig } from 'vite';

// M0: no framework plugin needed for the placeholder (esbuild handles tsx).
// @vitejs/plugin-react lands with the first real views in M4 (ADR-009).
export default defineConfig({});
