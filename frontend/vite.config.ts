import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import type { Plugin } from 'vite';

function renameIndexToAppHtml(): Plugin {
  return {
    name: 'tokenstar-rename-app-html',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const indexAsset = bundle['index.html'];
      if (indexAsset) {
        delete bundle['index.html'];
        indexAsset.fileName = 'app.html';
        bundle['app.html'] = indexAsset;
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), viteSingleFile(), renameIndexToAppHtml()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  test: {
    environment: 'jsdom',
  },
});
