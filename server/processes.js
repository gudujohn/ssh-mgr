// 跨平台进程扫描与端口探测。
// macOS/Linux: ps；Windows: PowerShell Get-CimInstance（不依赖 wmic，Win10+ 自带）。
import { execFile } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'

const IS_WIN = os.platform() === 'win32'

function run(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.trim() || err.message))
      else resolve(stdout)
    })
  })
}

// 返回 [{ pid, args }] —— 仅 ssh 客户端进程
export async function scanSshProcesses() {
  if (IS_WIN) {
    const ps = [
      'Get-CimInstance Win32_Process -Filter "Name=\'ssh.exe\'"',
      '| Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
    ].join(' ')
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps])
    if (!out.trim()) return []
    let data = JSON.parse(out)
    if (!Array.isArray(data)) data = [data]
    return data
      .filter((p) => p.CommandLine)
      .map((p) => ({ pid: p.ProcessId, args: String(p.CommandLine) }))
  }
  const out = await run('ps', ['-axo', 'pid=,args='])
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const sp = l.indexOf(' ')
      return { pid: Number(l.slice(0, sp)), args: l.slice(sp + 1) }
    })
    .filter((p) => {
      const bin = p.args.split(/\s+/)[0] ?? ''
      // 匹配 ssh / /usr/bin/ssh 等，排除 ssh-agent、sshd、scp、sftp、autossh 包装
      const base = bin.split('/').pop()
      return base === 'ssh' || base === 'ssh.exe'
    })
}

// 判断一条 ssh 命令行是否是指向目标 Host 的连接进程。
// targets 为该 Host 的所有可识别标识：别名 + HostName（终端里执行的是还原后的
// 原始命令，目标参数是 HostName 而非别名；后台启动用的是别名）。
// 注意：隧道 Host 的转发由 -L/-R/-D 参数或 config 携带，任何到该目标的 ssh 连接
// 都会建立转发，因此目标匹配即视为隧道载体；转发是否真正生效由端口探测判定。
export function matchTunnelArgs(args, targets) {
  const list = Array.isArray(targets) ? targets : [targets]
  const tokens = args.split(/\s+/)
  return tokens.some((t) => list.includes(t))
}

export async function findTunnelProcesses(targets, managedPids = []) {
  const procs = await scanSshProcesses()
  return procs
    .filter((p) => matchTunnelArgs(p.args, targets))
    .map((p) => ({ pid: p.pid, args: p.args, managed: managedPids.includes(p.pid) }))
}

export function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function killPid(pid) {
  return new Promise((resolve, reject) => {
    if (IS_WIN) {
      execFileKill('taskkill', ['/PID', String(pid), '/T', '/F'], resolve, reject)
    } else {
      execFileKill('kill', [String(pid)], resolve, reject)
    }
  })
}

function execFileKill(cmd, args, resolve, reject) {
  execFile(cmd, args, { timeout: 5000 }, (err, stdout, stderr) => {
    if (err) reject(new Error(stderr?.trim() || err.message))
    else resolve()
  })
}

// 探测本地 TCP 端口是否可连接（用于验证 LocalForward/DynamicForward 实际生效）
export function checkPort(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    let done = false
    const finish = (ok) => {
      if (!done) {
        done = true
        sock.destroy()
        resolve(ok)
      }
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
    try {
      sock.connect(port, host)
    } catch {
      finish(false)
    }
  })
}
