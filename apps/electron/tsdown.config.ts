import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: {
      index: 'lib/types/index.js',
      main: 'lib/types/main.js',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: { neverBundle: ['electron'] },
  },
  {
    entry: { preload: 'lib/types/preload.js' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'node',
    target: 'es2024',
    dts: false,
    clean: false,
    deps: { neverBundle: ['electron'] },
    outputOptions: {
      entryFileNames: '[name].cjs',
    },
  },
])
