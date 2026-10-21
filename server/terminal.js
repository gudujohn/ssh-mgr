// 打开系统终端执行 ssh 命令。
// 命令由后端从配置还原（buildSshArgv），终端里看到的是完整原始命令而非别名。
// macOS: 优先 iTerm2，其次 Terminal.app；Windows: 优先 Windows Terminal，其次 cmd。
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { shquote } from './sshCommand.js'

const IS_WIN = os.platform() === 'win32'

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 8000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.trim() || err.message))
      else resolve(stdout)
    })
  })
}

function pathJoinHome(p) {
  return os.homedir() + '/' + p
}

// AppleScript 双引号字符串转义
function escapeAppleScript(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

async function openMacCommand(commandStr) {
  const cmd = escapeAppleScript(commandStr)
  const hasIterm =
    fs.existsSync('/Applications/iTerm.app') || fs.existsSync(pathJoinHome('Applications/iTerm.app'))

  if (hasIterm) {
    const script = [
      'tell application "iTerm2"',
      '  create window with default profile',
      `  tell current session of current window to write text "${cmd}"`,
      '  activate',
      'end tell',
    ]
    await run('osascript', script.flatMap((l) => ['-e', l]))
    return 'iTerm2'
  }

  const script = [
    'tell application "Terminal"',
    '  activate',
    `  do script "${cmd}"`,
    'end tell',
  ]
  await run('osascript', script.flatMap((l) => ['-e', l]))
  return 'Terminal'
}

async function openWindowsArgs(argv) {
  // cmd /c start 会展开 % 变量，ProxyCommand 里的 %h %p 需要转义为 %%
  const escaped = argv.map((a) => a.replace(/%/g, '%%'))
  try {
    await run('where.exe', ['wt'])
    await run('cmd.exe', ['/c', 'start', '""', 'wt.exe', ...escaped])
    return 'Windows Terminal'
  } catch {
    await run('cmd.exe', ['/c', 'start', '""', 'cmd.exe', '/k', ...escaped])
    return 'cmd'
  }
}

async function openLinuxCommand(commandStr) {
  const candidates = [
    ['x-terminal-emulator', ['-e', commandStr]],
    ['gnome-terminal', ['--', 'bash', '-c', commandStr]],
    ['konsole', ['-e', commandStr]],
    ['xterm', ['-e', commandStr]],
  ]
  for (const [cmd, args] of candidates) {
    try {
      await run('which', [cmd])
      execFile(cmd, args, { detached: true, stdio: 'ignore' }).unref()
      return cmd
    } catch {
      /* try next */
    }
  }
  throw new Error('未找到可用的终端程序')
}

// argv: ['ssh', '-p', '49327', ...]（内部构造，不接受外部拼接字符串）
export async function openTerminalArgs(argv) {
  const commandStr = argv.map(shquote).join(' ')
  if (IS_WIN) return { terminal: await openWindowsArgs(argv), command: commandStr }
  if (os.platform() === 'darwin') return { terminal: await openMacCommand(commandStr), command: commandStr }
  return { terminal: await openLinuxCommand(commandStr), command: commandStr }
}
