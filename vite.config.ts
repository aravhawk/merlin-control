import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// `npm run lan` / `npm run lan:dev` set HTTPS=1: browsers only expose the webcam on
// https:// or localhost, so other devices on the network need a (self-signed) TLS cert.
const https = process.env.HTTPS === '1';
const mediapipeVersion = JSON.parse(
  readFileSync(new URL('./node_modules/@mediapipe/tasks-vision/package.json', import.meta.url), 'utf8')
).version;

export default defineConfig({
  base: './', // works from any sub-path / static host
  plugins: https ? [basicSsl()] : [],
  define: { __MEDIAPIPE_VERSION__: JSON.stringify(mediapipeVersion) },
  build: { target: 'es2022', chunkSizeWarningLimit: 1400 },
  server: { host: true },
  preview: { host: true, port: 4173 },
});
