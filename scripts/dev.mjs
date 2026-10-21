// 同时启动后端 API 与 Vite 开发服务器，并把 CLI 参数（--host/--port 等）透传给 Vite
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const viteArgs = process.argv.slice(2)

const server = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
  stdio: 'inherit',
  cwd: root,
})
const vite = spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), ...viteArgs], {
  stdio: 'inherit',
  cwd: root,
})

function shutdown(code = 0) {
  server.kill()
  vite.kill()
  process.exit(code)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
vite.on('exit', (code) => shutdown(code ?? 0))
server.on('exit', (code) => {
  console.error(`[ssh-mgr] backend exited with code ${code}`)
  shutdown(code ?? 1)
})
