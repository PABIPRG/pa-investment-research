import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const src = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /^@deepseek-ai\/dsh-client-ui-primitives$/,
        replacement: src('../../packages/client/ui-primitives/src/index.ts'),
      },
    ],
  },
  server: { port: 3198, strictPort: true },
  preview: { port: 3198, strictPort: true },
})
