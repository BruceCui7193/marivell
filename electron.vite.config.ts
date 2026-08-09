import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

const workerNonDomDecoderPlugin = {
  name: 'worker-non-dom-decoder',
  enforce: 'pre' as const,
  resolveId(source: string) {
    if (
      source === 'decode-named-character-reference' ||
      source.endsWith('decode-named-character-reference/index.dom.js')
    ) {
      return resolve(__dirname, 'node_modules/decode-named-character-reference/index.js');
    }
    return null;
  },
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
    build: {
      sourcemap: false,
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
    build: {
      sourcemap: false,
    },
  },
  renderer: {
    worker: {
      plugins: () => [workerNonDomDecoderPlugin],
    },
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer'),
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
    plugins: [react()],
  },
});
