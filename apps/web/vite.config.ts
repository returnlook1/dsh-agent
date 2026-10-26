import { mkdirSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

const srcDir = fileURLToPath(new URL('./src', import.meta.url))
// 类型可以直接从 shared 的源码取；运行期不导入 shared（见 src/constants.ts），
// 所以这里指向源码即可，不依赖 `packages/shared/dist` 是否已构建。
const sharedSrc = fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url))

// esbuild 的 JS API 会在 OS 临时目录写/删中间文件；受限环境里 %TEMP% 可能不可写
// （Windows 会报 `remove ... Access is denied`）。固定到已忽略的 .tmp/ 下更稳。
const buildTempDir = fileURLToPath(new URL('../../.tmp/vite-esbuild', import.meta.url))
mkdirSync(buildTempDir, { recursive: true })
process.env.TEMP = buildTempDir
process.env.TMP = buildTempDir

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': srcDir,
      '@agent-studio/shared': sharedSrc,
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
        // SSE 是长连接，关闭 ws 并让代理原样转发流。
        ws: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1400,
  },
})
