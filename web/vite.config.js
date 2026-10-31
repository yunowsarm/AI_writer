// 开发服务器通过同源代理访问 Express，Cookie 不暴露给跨域脚本。
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
export default defineConfig({
  plugins: [vue()],
  // 端口被占用时明确报错，不自动换端口，避免页面地址与 APP_ORIGIN 不一致。
  server: { port: 3003, strictPort: true, proxy: { '/api': 'http://127.0.0.1:31001' } },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['vue', 'vue-router', 'pinia'],
          ui: ['element-plus'],
          editor: ['@tiptap/vue-3', '@tiptap/starter-kit'],
        },
      },
    },
  },
})
