// 从解析出的 Host 配置还原完整 ssh 命令（不依赖 ssh 再读 config，所见即所执行）。
//
// mode:
//   'connect' —— 交互登录会话：不带任何转发参数（连跳板机本身，不建隧道）
//   'tunnel'  —— 隧道会话：-T（终端）或 -N（后台），带转发参数
// forwardIds:
//   转发规则的下标数组，仅启用选中的转发；undefined/null = 全部启用
// background:
//   仅 mode='tunnel' 有效：true 时用 -N 后台形态 + BatchMode（免交互，密钥/agent 认证）

export function buildSshArgv(host, { mode = 'connect', forwardIds = null, background = false } = {}) {
  const args = ['ssh']
  if (mode === 'tunnel') args.push(background ? '-N' : '-T')
  if (host.port) args.push('-p', String(host.port))
  if (host.user) args.push('-l', host.user)
  if (host.identityFile) args.push('-i', host.identityFile)
  if (host.proxyJump) args.push('-J', host.proxyJump)
  if (host.proxyCommand) args.push('-o', `ProxyCommand=${host.proxyCommand}`)

  if (mode === 'tunnel') {
    const forwards = (host.forwards ?? []).filter(
      (_, i) => forwardIds == null || forwardIds.includes(i)
    )
    for (const f of forwards) {
      if (f.type === 'local') {
        const listen = f.bind ? `${f.bind}:${f.localPort}` : `${f.localPort}`
        args.push('-L', `${listen}:${f.remoteHost}:${f.remotePort}`)
      } else if (f.type === 'remote') {
        const listen = f.bind ? `${f.bind}:${f.remoteListenPort}` : `${f.remoteListenPort}`
        args.push('-R', `${listen}:${f.remoteHost}:${f.remotePort}`)
      } else if (f.type === 'dynamic') {
        const listen = f.bind ? `${f.bind}:${f.localPort}` : `${f.localPort}`
        args.push('-D', listen)
      }
    }
    args.push('-o', 'ServerAliveInterval=30', '-o', 'ExitOnForwardFailure=yes')
    if (background) args.push('-o', 'BatchMode=yes', '-o', 'ServerAliveCountMax=3')
  }

  args.push(host.hostName ?? host.alias)
  return args
}

// shell 安全引用：安全字符原样输出，其余用单引号包裹
export function shquote(s) {
  return /^[A-Za-z0-9._@%+=:,/~-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`
}

export function buildSshCommand(host, opts = {}) {
  return buildSshArgv(host, opts).map(shquote).join(' ')
}
