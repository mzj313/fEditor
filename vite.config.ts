import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "es2022",
    sourcemap: false,
    // 每次构建清空 dist：Tauri 会把整个目录打进安装包，
    // 保留旧 hash 文件会让产物从 8 MB 一路涨到几十 MB
    emptyOutDir: true,
    rollupOptions: {
      // 桌面歌词是独立窗口页面，需要单独作为入口打包
      input: {
        main: "index.html",
        "desktop-lyrics": "src/pages/desktop-lyrics.html",
      },
    },
  },
});
