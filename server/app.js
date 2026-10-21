// SSH Manager 本地后端 API 应用（路由与 listen 分离，便于测试）
import express from 'express'
import os from 'node:os'
import { parseSshConfig, appendHostBlock, updateHostBlock, removeManagedBlock, CONFIG_PATH } from './sshConfig.js'
import { openTerminalArgs } from './terminal.js'
import { buildSshArgv } from './sshCommand.js'
import { startTunnel, stopTunnel, tunnelStatus } from './tunnels.js'

export function createApp() {
  const app = express()
  app.use(express.json())

  const wrap = (fn) => (req, res) => {
    Promise.resolve(fn(req, res))
      .then((out) => {
        if (!res.headersSent) res.json(out ?? {})
      })
      .catch((e) => {
        res.status(400).json({ error: e.message })
      })
  }

  app.get('/api/info', (req, res) => {
    res.json({
      platform: os.platform(),
      configPath: CONFIG_PATH,
    })
  })

  app.get('/api/hosts', wrap(() => {
    const { hosts, errors, configExists } = parseSshConfig()
    return { hosts: hosts.filter((h) => h.connectable), errors, configExists }
  }))

  app.get('/api/tunnels', wrap(async () => {
    const { hosts, errors, configExists } = parseSshConfig()
    const tunnels = hosts.filter((h) => h.isTunnel && !h.wildcard)
    const withStatus = await Promise.all(
      tunnels.map(async (h) => ({ ...h, state: await tunnelStatus(h) }))
    )
    return { tunnels: withStatus, errors, configExists }
  }))

  // 单独刷新某条隧道状态（轻量轮询用）
  app.get('/api/tunnels/:alias/status', wrap(async (req) => {
    const { hosts } = parseSshConfig()
    const h = hosts.find((x) => x.alias === req.params.alias && x.isTunnel)
    if (!h) throw new Error('隧道配置不存在')
    return tunnelStatus(h)
  }))

  app.post('/api/connect', wrap(async (req) => {
    const { alias } = req.body ?? {}
    if (!alias) throw new Error('缺少 alias')
    const { hosts } = parseSshConfig()
    const h = hosts.find((x) => x.alias === alias && x.connectable)
    if (!h) throw new Error('Host 配置不存在')
    // 从配置还原完整原始命令（ssh -p ... -l ... host），不依赖别名解析
    return await openTerminalArgs(buildSshArgv(h))
  }))

  // 校验可选的 forwardIds（转发规则下标数组）
  const checkForwardIds = (forwardIds, count) => {
    if (forwardIds == null) return null
    if (!Array.isArray(forwardIds) || forwardIds.some((i) => !Number.isInteger(i) || i < 0 || i >= count)) {
      throw new Error('forwardIds 必须是有效的转发规则下标数组')
    }
    return forwardIds
  }

  app.post('/api/tunnels/:alias/start', wrap(async (req) => {
    const { hosts } = parseSshConfig()
    const h = hosts.find((x) => x.alias === req.params.alias && x.isTunnel)
    if (!h) throw new Error('隧道配置不存在')
    const forwardIds = checkForwardIds(req.body?.forwardIds, h.forwards.length)
    const r = await startTunnel(h, forwardIds)
    // 给 ssh 一点时间建立转发，再返回状态
    await new Promise((r2) => setTimeout(r2, 1200))
    return { ...r, state: await tunnelStatus(h) }
  }))

  app.post('/api/tunnels/:alias/start-terminal', wrap(async (req) => {
    const { hosts } = parseSshConfig()
    const h = hosts.find((x) => x.alias === req.params.alias && x.isTunnel)
    if (!h) throw new Error('隧道配置不存在')
    const forwardIds = checkForwardIds(req.body?.forwardIds, h.forwards.length)
    // 从配置还原完整原始隧道命令（ssh -T -p ... -l ... -L ... host），
    // 不加 -N：部分 JumpServer(koko) 版本不支持无会话连接；
    // 密码/动态口令等交互认证在终端里完成，会话保持期间转发生效。
    // 建立后会被识别为「运行中（外部）」。
    return await openTerminalArgs(buildSshArgv(h, { mode: 'tunnel', forwardIds }))
  }))

  app.post('/api/tunnels/:alias/stop', wrap(async (req) => {
    const { hosts } = parseSshConfig()
    const h = hosts.find((x) => x.alias === req.params.alias && x.isTunnel)
    if (!h) throw new Error('隧道配置不存在')
    const r = await stopTunnel(h)
    return { ...r, state: { alias: req.params.alias, status: 'stopped' } }
  }))

  // 校验连接/隧道的公共字段；ProxyCommand 允许空格（如 nc -x ... %h %p），但所有字段禁止换行
  const checkCommonFields = ({ alias, hostName, user, identityFile, proxyJump, proxyCommand }) => {
    if (!/^[A-Za-z0-9._-]+$/.test(alias ?? '')) throw new Error('别名只能包含字母、数字、点、下划线、横线')
    if (!hostName) throw new Error('缺少 HostName')
    for (const [k, v] of Object.entries({ hostName, user, identityFile, proxyJump, proxyCommand })) {
      if (v != null && (typeof v !== 'string' || /[\r\n]/.test(v))) throw new Error(`${k} 含有非法字符`)
    }
    for (const [k, v] of Object.entries({ hostName, user, proxyJump })) {
      if (v != null && /\s/.test(v)) throw new Error(`${k} 不能包含空白字符`)
    }
  }

  // 校验转发规则数组（新增/更新隧道共用）
  const checkForwards = (forwards) => {
    if (!Array.isArray(forwards) || forwards.length === 0) throw new Error('至少配置一条转发规则')
    for (const f of forwards) {
      if (!['local', 'remote', 'dynamic'].includes(f.type)) throw new Error('转发类型必须是 local/remote/dynamic')
      if (f.bind != null && /\s/.test(f.bind)) throw new Error('绑定地址含有非法字符')
      if (!Number.isInteger(f.listenPort) || f.listenPort < 1 || f.listenPort > 65535) {
        throw new Error(`监听端口无效: ${f.listenPort}`)
      }
      if (f.type !== 'dynamic') {
        if (!f.targetHost || /\s/.test(f.targetHost)) throw new Error('local/remote 转发需要合法的目标主机')
        if (!Number.isInteger(f.targetPort) || f.targetPort < 1 || f.targetPort > 65535) {
          throw new Error(`目标端口无效: ${f.targetPort}`)
        }
      }
    }
  }

  app.post('/api/tunnels', wrap(async (req) => {
    const { alias, hostName, user, port, identityFile, proxyJump, forwards } = req.body ?? {}
    checkCommonFields({ alias, hostName, user, identityFile, proxyJump })
    checkForwards(forwards)
    const { hosts } = parseSshConfig()
    if (hosts.some((h) => h.alias === alias)) throw new Error(`别名 ${alias} 已存在`)
    appendHostBlock({ alias, hostName, user, port, identityFile, proxyJump, forwards })
    return { ok: true }
  }))

  // 更新隧道（托管块整段重生成，手写块指令级修补）
  app.put('/api/tunnels/:alias', wrap(async (req) => {
    const { hostName, user, port, identityFile, proxyJump, forwards } = req.body ?? {}
    if (!hostName) throw new Error('缺少 HostName')
    for (const [k, v] of Object.entries({ hostName, user, identityFile, proxyJump })) {
      if (v != null && v !== '' && (typeof v !== 'string' || /[\r\n]/.test(v))) throw new Error(`${k} 含有非法字符`)
    }
    checkForwards(forwards)
    updateHostBlock(req.params.alias, { hostName, user, port, identityFile, proxyJump, forwards })
    return { ok: true }
  }))

  // 新增连接（纯 Host 块，无转发指令）
  app.post('/api/hosts', wrap(async (req) => {
    const { alias, hostName, user, port, identityFile, proxyJump, proxyCommand } = req.body ?? {}
    checkCommonFields({ alias, hostName, user, identityFile, proxyJump, proxyCommand })
    const { hosts } = parseSshConfig()
    if (hosts.some((h) => h.alias === alias)) throw new Error(`别名 ${alias} 已存在`)
    appendHostBlock({ alias, hostName, user, port, identityFile, proxyJump, proxyCommand })
    return { ok: true }
  }))

  // 更新连接（不触碰转发指令）
  app.put('/api/hosts/:alias', wrap(async (req) => {
    const { hostName, user, port, identityFile, proxyJump, proxyCommand } = req.body ?? {}
    if (!hostName) throw new Error('缺少 HostName')
    for (const [k, v] of Object.entries({ hostName, user, identityFile, proxyJump, proxyCommand })) {
      if (v != null && v !== '' && (typeof v !== 'string' || /[\r\n]/.test(v))) throw new Error(`${k} 含有非法字符`)
    }
    updateHostBlock(req.params.alias, { hostName, user, port, identityFile, proxyJump, proxyCommand })
    return { ok: true }
  }))

  app.delete('/api/hosts/:alias', wrap(async (req) => {
    removeManagedBlock(req.params.alias)
    return { ok: true }
  }))

  app.delete('/api/tunnels/:alias', wrap(async (req) => {
    removeManagedBlock(req.params.alias)
    return { ok: true }
  }))

  return app
}
