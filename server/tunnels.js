// 隧道启动 / 停止 / 状态判定。
// 状态语义：
//   running  —— 本工具启动的 ssh 进程存活，且已启用的本地转发端口可连通
//   external —— 检测到匹配的外部 ssh 进程（用户自己在终端启动的），端口可连通
//   error    —— 进程存在但已启用的本地端口探测失败（转发未生效或刚启动未就绪）
//   stopped  —— 无匹配进程
// 「已启用」的判定：进程命令行里显式出现的 -L/-R/-D 参数（原始命令形态）；
// 命令行无转发参数（ssh 别名，转发由 config 携带）时按配置全量判定。
import { spawn } from 'node:child_process'
import { buildSshArgv } from './sshCommand.js'
import {
  findTunnelProcesses,
  isPidAlive,
  killPid,
  checkPort,
} from './processes.js'

// alias -> { pid, startedAt, stderr }
const managed = new Map()

// 从 ssh 命令行提取显式转发参数：支持 -L xxx、-NL xxx、-Lxxx 等形态
export function extractForwardSpecs(args) {
  const tokens = args.split(/\s+/)
  const specs = []
  for (let i = 0; i < tokens.length; i++) {
    const m = tokens[i].match(/^-([A-Za-z]*)([DLR])(\S*)$/)
    if (!m) continue
    if (m[3]) {
      specs.push({ flag: m[2], value: m[3] })
    } else if (i + 1 < tokens.length) {
      specs.push({ flag: m[2], value: tokens[i + 1] })
      i++
    }
  }
  return specs
}

// 解析转发参数值里的监听端口（L/R: [bind:]listenPort:host:port；D: [bind:]port）
function specListenPort(value, hasTarget) {
  const parts = value.split(':')
  if (hasTarget && parts.length >= 3) parts.splice(-2)
  return Number(parts[parts.length - 1])
}

function specMatchesForward(f, s) {
  if (f.type === 'local' && s.flag === 'L') return specListenPort(s.value, true) === f.localPort
  if (f.type === 'remote' && s.flag === 'R') return specListenPort(s.value, true) === f.remoteListenPort
  if (f.type === 'dynamic' && s.flag === 'D') return specListenPort(s.value, false) === f.localPort
  return false
}

// 计算一组进程实际启用的配置转发下标；进程无显式转发参数时返回全部
export function activeForwardIds(host, procs) {
  const specs = procs.flatMap((p) => extractForwardSpecs(p.args))
  if (procs.length === 0) return []
  if (specs.length === 0) return host.forwards.map((_, i) => i) // config 携带的全量转发
  const ids = []
  host.forwards.forEach((f, i) => {
    if (specs.some((s) => specMatchesForward(f, s))) ids.push(i)
  })
  return ids
}

export function startTunnel(host, forwardIds = null) {
  return new Promise((resolve, reject) => {
    const alias = host.alias
    const existing = managed.get(alias)
    if (existing && isPidAlive(existing.pid)) {
      reject(new Error(`隧道已在运行 (PID ${existing.pid})`))
      return
    }
    // 后台形态：从配置还原原始命令（-T + 选中的转发 + BatchMode 免交互）。
    // 不用 -N（JumpServer 等网关在无会话连接上不处理转发请求）。
    // stdin 用 pipe 且保持挂起不写不关：-T 无 -N 时远端会话从 stdin 读命令，
    // 挂起可让会话一直存活；若给 /dev/null 会读到 EOF 导致会话退出、隧道中断。
    const argv = buildSshArgv(host, { mode: 'tunnel', background: true, forwardIds })
    const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'ignore', 'pipe'] })
    child.stdin.on('error', () => {}) // 进程退出时忽略 EPIPE
    const rec = { pid: child.pid, startedAt: Date.now(), stderr: '' }
    child.stderr.on('data', (d) => {
      rec.stderr = (rec.stderr + d.toString()).slice(-2048)
    })
    child.on('error', (e) => {
      managed.delete(alias)
      reject(new Error(`启动 ssh 失败: ${e.message}`))
    })
    child.on('exit', () => {
      // 进程退出仅清理记录；状态以扫描为准
      const cur = managed.get(alias)
      if (cur && cur.pid === child.pid) managed.delete(alias)
    })
    managed.set(alias, rec)
    resolve({ pid: child.pid })
  })
}

export async function stopTunnel(host) {
  const targets = [host.alias, host.hostName].filter(Boolean)
  const procs = await findTunnelProcesses(targets, [...managed.values()].map((m) => m.pid))
  if (procs.length === 0) {
    managed.delete(host.alias)
    throw new Error('没有正在运行的匹配隧道进程')
  }
  const errors = []
  for (const p of procs) {
    try {
      await killPid(p.pid)
    } catch (e) {
      errors.push(`PID ${p.pid}: ${e.message}`)
    }
  }
  managed.delete(host.alias)
  if (errors.length) throw new Error(errors.join('; '))
  return { killed: procs.map((p) => p.pid) }
}

export async function tunnelStatus(host) {
  const alias = host.alias
  const managedRec = managed.get(alias)
  const managedPid = managedRec && isPidAlive(managedRec.pid) ? managedRec.pid : null
  if (managedRec && !managedPid) managed.delete(alias)

  // 终端里执行的是还原后的原始命令（目标为 HostName），后台启动用的是别名，两者都匹配
  const targets = [host.alias, host.hostName].filter(Boolean)
  const procs = await findTunnelProcesses(targets, managedPid ? [managedPid] : [])

  // 只探测「已启用」的本地转发端口（LocalForward / DynamicForward）
  const active = activeForwardIds(host, procs)
  const localChecks = host.forwards
    .map((f, i) => ({ f, i }))
    .filter(({ f, i }) => active.includes(i) && (f.type === 'local' || f.type === 'dynamic'))
    .map(({ f }) => ({ port: f.localPort, bind: f.bind }))

  let portResults = []
  if (procs.length > 0 && localChecks.length > 0) {
    portResults = await Promise.all(
      localChecks.map(async (c) => ({
        port: c.port,
        ok: await checkPort(c.port, c.bind && c.bind !== '0.0.0.0' ? c.bind : '127.0.0.1'),
      }))
    )
  }

  let status
  if (procs.length === 0) {
    status = 'stopped'
  } else {
    const portsOk = portResults.every((r) => r.ok)
    // 进程存在 + （无本地端口可校验 或 端口全部连通） → running / external
    status = portsOk ? (managedPid ? 'running' : 'external') : 'error'
  }

  return {
    alias,
    status,
    processes: procs,
    ports: portResults,
    activeForwardIds: active,
    managedPid,
    lastError: managedRec?.stderr?.trim() || null,
    checkedAt: Date.now(),
  }
}

export function managedTunnelAliases() {
  return [...managed.entries()]
    .filter(([, v]) => isPidAlive(v.pid))
    .map(([alias, v]) => ({ alias, pid: v.pid, startedAt: v.startedAt }))
}
