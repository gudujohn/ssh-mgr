// ssh_config 解析：只读本机已有配置（~/.ssh/config 及 Include 引入的文件），
// 不维护任何独立配置。解析 Host 块与 LocalForward/RemoteForward/DynamicForward。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const SSH_DIR = path.join(os.homedir(), '.ssh')
export const CONFIG_PATH = path.join(SSH_DIR, 'config')

const MANAGED_BEGIN = /^# >>> ssh-mgr: (.+)$/
const MANAGED_END = /^# <<< ssh-mgr$/

// 解析一条转发指令的值，例如：
//   LocalForward 8080 localhost:80
//   LocalForward 127.0.0.1:5432 db.internal:5432
//   DynamicForward 1080
//   RemoteForward 9090 localhost:9000
function parseForward(kind, value) {
  const tokens = value.trim().split(/\s+/)
  if (tokens.length === 0 || !tokens[0]) return null

  const splitBindPort = (tok) => {
    // 支持 [IPv6]:port、host:port、纯 port
    const m = tok.match(/^\[(.+)]:(\d+)$/)
    if (m) return { bind: m[1], port: Number(m[2]) }
    const idx = tok.lastIndexOf(':')
    if (idx > 0) {
      const maybePort = Number(tok.slice(idx + 1))
      if (Number.isInteger(maybePort)) {
        return { bind: tok.slice(0, idx) || undefined, port: maybePort }
      }
    }
    const p = Number(tok)
    if (Number.isInteger(p)) return { bind: undefined, port: p }
    return null // socket 形式等暂不识别端口
  }

  const listen = splitBindPort(tokens[0])
  if (!listen) return null

  if (kind === 'dynamic') {
    return { type: 'dynamic', bind: listen.bind, localPort: listen.port }
  }

  const targetTok = tokens[1]
  if (!targetTok) return null
  const target = splitBindPort(targetTok)
  if (!target) return null

  if (kind === 'local') {
    return {
      type: 'local',
      bind: listen.bind,
      localPort: listen.port,
      remoteHost: target.bind ?? targetTok.replace(/:\d+$/, ''),
      remotePort: target.port,
    }
  }
  // remote
  return {
    type: 'remote',
    bind: listen.bind,
    remoteListenPort: listen.port,
    remoteHost: target.bind ?? targetTok.replace(/:\d+$/, ''),
    remotePort: target.port,
  }
}

function resolveInclude(pattern, fromFile) {
  // ssh 规则：用户配置中的相对路径相对于 ~/.ssh
  let p = pattern.replace(/^~(?=$|\/|\\)/, os.homedir())
  if (!path.isAbsolute(p)) p = path.join(SSH_DIR, p)
  return p
}

function expandGlob(pattern) {
  // 简单 glob 展开：仅支持 * 与 ?
  if (!/[*?]/.test(pattern)) return fs.existsSync(pattern) ? [pattern] : []
  const dir = path.dirname(pattern)
  const base = path.basename(pattern)
  const re = new RegExp(
    '^' + base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$'
  )
  try {
    return fs.readdirSync(dir)
      .filter((f) => re.test(f))
      .map((f) => path.join(dir, f))
      .sort()
  } catch {
    return []
  }
}

function parseFile(filePath, hosts, visited, errors) {
  const real = path.resolve(filePath)
  if (visited.has(real)) return
  visited.add(real)

  let content
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch (e) {
    if (filePath === CONFIG_PATH) return // 主配置不存在不报错
    errors.push(`无法读取 Include 文件: ${filePath}`)
    return
  }

  const lines = content.split(/\r?\n/)
  let current = null
  let managedDepth = false
  let prevComment = null

  const flush = (endLine) => {
    if (current) {
      current.lineEnd = endLine
      hosts.push(current)
      current = null
    }
  }

  lines.forEach((raw, i) => {
    const lineNo = i + 1
    const trimmed = raw.trim()

    const mb = trimmed.match(MANAGED_BEGIN)
    if (mb) {
      managedDepth = true
      prevComment = null // 标记行不作为转发描述
      return
    }
    if (MANAGED_END.test(trimmed)) {
      if (current) current.managed = true
      managedDepth = false
      flush(lineNo)
      return
    }

    if (!trimmed) {
      prevComment = null // 空行打断注释与转发指令的关联
      return
    }
    if (trimmed.startsWith('#')) {
      // 紧邻转发指令上方的注释行 = 该转发的描述
      prevComment = trimmed.replace(/^#+\s?/, '')
      return
    }

    const m = trimmed.match(/^(\S+)\s+(.+)$/) || trimmed.match(/^(\S+)=(.*)$/)
    if (!m) return
    const keyword = m[1].toLowerCase()
    const value = (m[2] ?? '').trim()

    if (keyword === 'include') {
      flush(lineNo - 1)
      for (const part of value.split(/\s+/)) {
        for (const f of expandGlob(resolveInclude(part, filePath))) {
          parseFile(f, hosts, visited, errors)
        }
      }
      return
    }

    if (keyword === 'host') {
      flush(lineNo - 1)
      const patterns = value.split(/\s+/)
      current = {
        patterns,
        alias: patterns.find((p) => !/[*?!]/.test(p)) ?? null,
        wildcard: patterns.every((p) => /[*?]/.test(p)),
        options: {},
        forwards: [],
        source: filePath,
        managed: managedDepth,
        lineStart: lineNo,
        lineEnd: lineNo,
      }
      return
    }

    if (!current) return // Host 之前的全局选项忽略

    if (keyword === 'localforward' || keyword === 'remoteforward' || keyword === 'dynamicforward') {
      const kind = keyword === 'localforward' ? 'local' : keyword === 'remoteforward' ? 'remote' : 'dynamic'
      const f = parseForward(kind, value)
      if (f) {
        if (prevComment) f.desc = prevComment
        current.forwards.push(f)
      }
      prevComment = null
      return
    }

    prevComment = null
    // 记录常用选项（同关键字出现多次时保留首个，符合 ssh 语义）
    if (!(keyword in current.options)) current.options[keyword] = value
  })
  flush(lines.length)
}

export function parseSshConfig() {
  const hosts = []
  const errors = []
  parseFile(CONFIG_PATH, hosts, new Set(), errors)

  const list = hosts.map((h) => ({
    alias: h.alias,
    patterns: h.patterns,
    wildcard: h.wildcard,
    hostName: h.options.hostname ?? null,
    user: h.options.user ?? null,
    port: h.options.port ?? null,
    identityFile: h.options.identityfile ?? null,
    proxyJump: h.options.proxyjump ?? null,
    proxyCommand: h.options.proxycommand ?? null,
    forwards: h.forwards,
    isTunnel: h.forwards.length > 0,
    connectable: !h.wildcard && h.alias !== null,
    source: h.source,
    managed: h.managed,
    lineStart: h.lineStart,
    lineEnd: h.lineEnd,
  }))

  return { hosts: list, errors, configPath: CONFIG_PATH, configExists: fs.existsSync(CONFIG_PATH) }
}

// 生成 Host 块的文本行（managed 时带 ssh-mgr 标记）
function generateBlockLines({ alias, hostName, user, port, identityFile, proxyJump, proxyCommand, forwards = [] }, managed = true) {
  const lines = []
  if (managed) lines.push(`# >>> ssh-mgr: ${alias}`)
  lines.push(`Host ${alias}`)
  if (hostName) lines.push(`    HostName ${hostName}`)
  if (user) lines.push(`    User ${user}`)
  if (port) lines.push(`    Port ${port}`)
  if (identityFile) lines.push(`    IdentityFile ${identityFile}`)
  if (proxyJump) lines.push(`    ProxyJump ${proxyJump}`)
  if (proxyCommand) lines.push(`    ProxyCommand ${proxyCommand}`)
  for (const f of forwards) {
    if (f.desc) lines.push(`    # ${String(f.desc).replace(/[\r\n#]/g, ' ').trim()}`)
    const listen = f.bind ? `${f.bind}:${f.listenPort}` : `${f.listenPort}`
    if (f.type === 'local') lines.push(`    LocalForward ${listen} ${f.targetHost}:${f.targetPort}`)
    else if (f.type === 'remote') lines.push(`    RemoteForward ${listen} ${f.targetHost}:${f.targetPort}`)
    else lines.push(`    DynamicForward ${listen}`)
  }
  if (managed) lines.push(`# <<< ssh-mgr`)
  return lines
}

// 追加一个托管 Host 块到主配置文件（带标记，便于识别与删除）。
// forwards 为空时为纯连接配置；非空时为隧道配置。
export function appendHostBlock(fields) {
  const lines = ['', ...generateBlockLines(fields), '']
  fs.mkdirSync(SSH_DIR, { recursive: true })
  fs.appendFileSync(CONFIG_PATH, lines.join('\n'), { mode: 0o600 })
}

// 对手写块做外科手术式修改：只替换/插入/删除已知指令行，
// 注释、空行和工具不认识的指令（ServerAliveInterval 等）原样保留。
// fields 中 undefined = 不动该指令；''/null = 删除该指令；其余 = 设置。
// fields.forwards 提供时：整体替换该块的所有转发指令。
function patchBlockLines(blockLines, fields) {
  const KNOWN = [
    ['hostname', 'HostName', fields.hostName],
    ['user', 'User', fields.user],
    ['port', 'Port', fields.port],
    ['identityfile', 'IdentityFile', fields.identityFile],
    ['proxyjump', 'ProxyJump', fields.proxyJump],
    ['proxycommand', 'ProxyCommand', fields.proxyCommand],
  ]
  let lines = [...blockLines]
  let insertAt = 1 // 缺失指令插入到 Host 行之后，保持 KNOWN 的顺序
  for (const [kw, name, value] of KNOWN) {
    if (value === undefined) continue
    const idx = lines.findIndex((l) => new RegExp(`^\\s*${kw}(\\s|=)`, 'i').test(l))
    if (value === null || value === '') {
      if (idx >= 0) lines.splice(idx, 1)
      continue
    }
    const line = `    ${name} ${value}`
    if (idx >= 0) {
      lines[idx] = line
      insertAt = Math.max(insertAt, idx + 1)
    } else {
      lines.splice(Math.min(insertAt, lines.length), 0, line)
      insertAt++
    }
  }
  if (fields.forwards) {
    // 移除转发指令行，以及紧邻其上方的描述注释行（避免重复编辑后残留孤儿注释）
    const isFwd = (l) => /^\s*(localforward|remoteforward|dynamicforward)(\s|=)/i.test(l)
    lines = lines.filter((l, idx) => {
      if (isFwd(l)) return false
      if (/^\s*#/.test(l) && idx + 1 < lines.length && isFwd(lines[idx + 1])) return false
      return true
    })
    const fLines = generateBlockLines({ alias: '__x__', forwards: fields.forwards }, false).slice(1)
    lines.push(...fLines)
  }
  return lines
}

// 更新已有 Host 块（别名不可改；改名 = 删除 + 新增）。
// 托管块整段重新生成；手写块做指令级修补，其余行原样保留。
export function updateHostBlock(alias, fields) {
  const { hosts } = parseSshConfig()
  const target = hosts.find((h) => h.alias === alias && !h.wildcard)
  if (!target) throw new Error(`未找到 Host 配置: ${alias}`)

  const file = target.source
  const fileLines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  const start = target.lineStart - 1
  const end = target.lineEnd - 1 // 含

  if (target.managed) {
    // 托管块：连同标记整段重新生成
    const begin = Math.max(0, start - 1)
    const block = generateBlockLines({ alias, ...fields }, true)
    fileLines.splice(begin, end - begin + 1, ...block)
  } else {
    const block = fileLines.slice(start, end + 1)
    const patched = patchBlockLines(block, fields)
    fileLines.splice(start, end - start + 1, ...patched)
  }
  fs.writeFileSync(file, fileLines.join('\n'), { mode: 0o600 })
}

// 仅允许删除带 ssh-mgr 标记的块，避免误改用户手写配置
export function removeManagedBlock(alias) {
  const { hosts } = parseSshConfig()
  const target = hosts.find((h) => h.alias === alias && h.managed && h.source === CONFIG_PATH)
  if (!target) {
    const inOther = hosts.find((h) => h.alias === alias && h.managed)
    if (inOther) throw new Error(`该配置位于 ${inOther.source}，请直接编辑该文件`)
    throw new Error('未找到由本工具添加的该配置块（仅支持删除带 ssh-mgr 标记的块）')
  }
  const lines = fs.readFileSync(CONFIG_PATH, 'utf8').split(/\r?\n/)
  // 标记行在 Host 行上一行
  const begin = Math.max(0, target.lineStart - 2)
  const end = target.lineEnd - 1 // 含 <<< 标记行（flush 时已计入）
  lines.splice(begin, end - begin + 1)
  fs.writeFileSync(CONFIG_PATH, lines.join('\n'), { mode: 0o600 })
}
