// SSH Manager 本地后端 API 入口（仅监听 127.0.0.1）
import { createApp } from './app.js'

const PORT = Number(process.env.SSH_MGR_PORT || 8787)
createApp().listen(PORT, '127.0.0.1', () => {
  console.log(`[ssh-mgr] API listening on http://127.0.0.1:${PORT}`)
})
