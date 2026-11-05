import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { readFileSync } from 'node:fs'

const consolePackage = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const rootPath = new URL('../package.json', import.meta.url)
const project = JSON.parse(readFileSync(rootPath, 'utf8'))
if (project.version !== consolePackage.version)
  throw new Error('Console package version must match the root package version')
const version = project.version

export default defineConfig({
  plugins: [vue()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: {
    port: 5173,
    // 开发模式下把 /api 代理到本机网关
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/v1': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
})
