// 无 socket 的单元 / 集成测试（本沙箱禁止监听端口，因此用 mock req/res 调 Express 路由）
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import fs from 'node:fs'
import { matchTunnelArgs, scanSshProcesses } from '../server/processes.js'
import { buildSshCommand } from '../server/sshCommand.js'
import { extractForwardSpecs, activeForwardIds } from '../server/tunnels.js'
import { createApp } from '../server/app.js'

// 每次运行重建测试夹具，保证可重复（需要 HOME=/tmp/ssh-mgr-test 运行）
const SSH_DIR = '/tmp/ssh-mgr-test/.ssh'
fs.mkdirSync(`${SSH_DIR}/conf.d`, { recursive: true })
fs.writeFileSync(`${SSH_DIR}/config`, `Host *
    ServerAliveInterval 60

Host dev
    HostName 10.0.0.10
    User ubuntu

# >>> ssh-mgr: db-tunnel
Host db-tunnel
    HostName jump.example.com
    User ops
    # 生产库
    LocalForward 15432 db.internal:5432
    DynamicForward 1080
# <<< ssh-mgr

Include conf.d/*.conf
`)
fs.writeFileSync(`${SSH_DIR}/conf.d/web.conf`, `Host web-tunnel
    HostName 192.168.1.5
    # 旧描述
    RemoteForward 9090 localhost:9000
`)

let fail = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
  if (!cond) fail++
}

// 1) 隧道进程命令行匹配（别名或 HostName 匹配即可：转发由 -L 参数或 config 携带，
//    任何到该目标的连接都会建立转发；终端执行的是还原后的原始命令，目标是 HostName）
check('匹配 ssh -N alias', matchTunnelArgs('/usr/bin/ssh -N db-tunnel', ['db-tunnel', 'jump.example.com']))
check('匹配原始命令（目标是 HostName）', matchTunnelArgs('ssh -T -p 49327 -l u@root@1.2.3.4 -L 127.0.0.1:33061:172.16.60.97:3306 jump.huidatech.cn', ['jump-mysql-droneuser', 'jump.huidatech.cn']))
check('交互会话同样建立转发', matchTunnelArgs('ssh db-tunnel', ['db-tunnel', 'jump.example.com']))
check('拒绝别名是其它串的子串', !matchTunnelArgs('ssh -N db-tunnel-extra', ['db-tunnel', 'jump.example.com']))
check('拒绝不相关进程', !matchTunnelArgs('/usr/bin/ssh-agent -l', ['ssh']))
check('拒绝其它 alias', !matchTunnelArgs('ssh -N web-tunnel', ['db-tunnel', 'jump.example.com']))

// 2) 进程扫描返回数组且每项结构正确
const procs = await scanSshProcesses()
check('scanSshProcesses 结构', Array.isArray(procs) && procs.every((p) => Number.isInteger(p.pid) && typeof p.args === 'string'))

// 2b) 从配置还原原始命令（JumpServer demo 形态）
const jumpHost = {
  alias: 'jump-mysql-droneuser',
  hostName: 'jump.huidatech.cn',
  port: '49327',
  user: 'jianggengchao@root@172.16.60.95',
  forwards: [{ type: 'local', bind: '127.0.0.1', localPort: 33061, remoteHost: '172.16.60.97', remotePort: 3306 }],
}
const jumpCmd = buildSshCommand(jumpHost, { mode: 'tunnel' })
check(
  '隧道命令还原为原始形态',
  jumpCmd === 'ssh -T -p 49327 -l jianggengchao@root@172.16.60.95 -L 127.0.0.1:33061:172.16.60.97:3306 -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes jump.huidatech.cn',
  jumpCmd
)
// 2.1 连接模式：即使是隧道配置也不带转发参数
const connectCmd = buildSshCommand(jumpHost)
check('连接模式不带转发', connectCmd === 'ssh -p 49327 -l jianggengchao@root@172.16.60.95 jump.huidatech.cn', connectCmd)
// 2.2 按选择过滤转发
const multiHost = {
  alias: 'multi',
  hostName: 'jump.example.com',
  forwards: [
    { type: 'local', localPort: 1001, remoteHost: 'a', remotePort: 80 },
    { type: 'local', localPort: 1002, remoteHost: 'b', remotePort: 80 },
    { type: 'dynamic', localPort: 1080 },
  ],
}
const selCmd = buildSshCommand(multiHost, { mode: 'tunnel', forwardIds: [0, 2] })
check('按勾选过滤转发', selCmd === 'ssh -T -L 1001:a:80 -D 1080 -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes jump.example.com', selCmd)
const bgCmd = buildSshCommand(multiHost, { mode: 'tunnel', background: true, forwardIds: [1] })
check('后台形态 -N + BatchMode', bgCmd.startsWith('ssh -N -L 1002:b:80') && bgCmd.includes('BatchMode=yes'), bgCmd)
const plainCmd = buildSshCommand({ alias: 'dev', hostName: '10.0.0.10', user: 'ubuntu', identityFile: '~/.ssh/id_ed25519' })
check('普通连接命令还原', plainCmd === 'ssh -l ubuntu -i ~/.ssh/id_ed25519 10.0.0.10', plainCmd)
const socksCmd = buildSshCommand({ alias: 's', hostName: '172.16.1.2', user: 'root', proxyCommand: 'nc -X 5 -x 127.0.0.1:1080 %h %p' })
check('ProxyCommand 被正确引用', socksCmd === `ssh -l root -o 'ProxyCommand=nc -X 5 -x 127.0.0.1:1080 %h %p' 172.16.1.2`, socksCmd)

// 2c) 部分启用转发时的状态判定（修复：只探测实际启用的端口）
const specs1 = extractForwardSpecs('ssh -T -p 49327 -l u@r@ip -L 127.0.0.1:33061:172.16.60.97:3306 -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes jump.host')
check('提取 -L 参数', specs1.length === 1 && specs1[0].flag === 'L' && specs1[0].value === '127.0.0.1:33061:172.16.60.97:3306', JSON.stringify(specs1))
const specs2 = extractForwardSpecs('ssh -NL 15432:db:5432 -D 1080 host')
check('提取合并形态 -NL 与 -D', specs2.length === 2 && specs2[0].value === '15432:db:5432' && specs2[1].value === '1080', JSON.stringify(specs2))
check('无转发参数返回空', extractForwardSpecs('ssh -N -o BatchMode=yes host').length === 0)

const multiCfg = {
  alias: 'multi',
  hostName: 'jump.example.com',
  forwards: [
    { type: 'local', localPort: 1001, remoteHost: 'a', remotePort: 80 },
    { type: 'local', localPort: 1002, remoteHost: 'b', remotePort: 80 },
    { type: 'dynamic', localPort: 1080 },
  ],
}
// 只启用了 1001：命令行只带一条 -L → 只有下标 0 被判定为启用
const partialProcs = [{ pid: 1, args: 'ssh -N -L 1001:a:80 -o BatchMode=yes jump.example.com', managed: false }]
check('部分启用只算启用的转发', JSON.stringify(activeForwardIds(multiCfg, partialProcs)) === '[0]')
// 老式 config 会话（无显式转发参数）→ 全量启用
const legacyProcs = [{ pid: 2, args: 'ssh multi', managed: false }]
check('config 会话全量启用', JSON.stringify(activeForwardIds(multiCfg, legacyProcs)) === '[0,1,2]')
// 无进程 → 无启用
check('无进程无启用', activeForwardIds(multiCfg, []).length === 0)

// 3) startTunnel 涉及真实 ssh 进程，本沙箱禁止执行 ssh，无法在此测试；
//    其逻辑为薄封装（spawn ssh -N + 状态以进程扫描为准），在真实环境中验证。

// 4) Express 路由（mock req/res，不经 socket）
const app = createApp()
function call(method, url, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null
    // 用真实 Readable 作为 req，raw-body 依赖其内部状态
    const req = payload ? Readable.from([Buffer.from(payload)]) : Readable.from([])
    req.method = method
    req.url = url
    req.headers = {
      'content-type': 'application/json',
      ...(payload ? { 'content-length': String(Buffer.byteLength(payload)) } : {}),
    }
    const res = new EventEmitter()
    res.statusCode = 200
    res.setHeader = () => {}
    res.getHeader = () => undefined
    res.removeHeader = () => {}
    let out = ''
    res.write = (c) => { out += c }
    res.end = (c) => {
      if (c) out += c
      resolve({ status: res.statusCode, body: out ? JSON.parse(out) : {} })
    }
    res.json = (o) => res.end(JSON.stringify(o))
    res.status = (n) => { res.statusCode = n; return res }
    app.handle(req, res, (e) => (e ? reject(e) : resolve({ status: 404, body: {} })))
  })
}

const hosts = await call('GET', '/api/hosts')
check('GET /api/hosts 过滤通配符', hosts.status === 200 && hosts.body.hosts.length === 3, hosts.body.hosts?.map((h) => h.alias).join(','))

const tunnels = await call('GET', '/api/tunnels')
const db = tunnels.body.tunnels?.find((t) => t.alias === 'db-tunnel')
check('GET /api/tunnels 两条隧道', tunnels.status === 200 && tunnels.body.tunnels.length === 2)
check('db-tunnel 无进程时 stopped', db?.state.status === 'stopped', JSON.stringify(db?.state?.status))
check('转发描述从注释解析', db?.forwards?.[0]?.desc === '生产库' && db?.forwards?.[1]?.desc == null, JSON.stringify(db?.forwards?.map((f) => f.desc)))

const add = await call('POST', '/api/tunnels', {
  alias: 'mock-tunnel',
  hostName: '10.9.9.9',
  forwards: [{ type: 'local', listenPort: 18080, targetHost: 'svc', targetPort: 80, desc: '临时隧道描述' }],
})
check('POST /api/tunnels 新增', add.status === 200 && add.body.ok === true)

// 描述写入为转发上方的注释行，并能解析回读
const cfgAfterAdd = fs.readFileSync('/tmp/ssh-mgr-test/.ssh/config', 'utf8')
check('描述写入为注释行', /^\s*# 临时隧道描述\n\s*LocalForward 18080 svc:80$/m.test(cfgAfterAdd))
const hostsAfterAdd = await call('GET', '/api/hosts')
const mockT = hostsAfterAdd.body.hosts.find((h) => h.alias === 'mock-tunnel')
check('描述解析回读一致', mockT?.forwards?.[0]?.desc === '临时隧道描述', JSON.stringify(mockT?.forwards?.[0]?.desc))

const badDesc = await call('POST', '/api/tunnels', {
  alias: 'bad-desc',
  hostName: 'x',
  forwards: [{ type: 'local', listenPort: 1, targetHost: 's', targetPort: 2, desc: 'a\nb' }],
})
check('描述换行注入被拒', badDesc.status === 400)

const dup = await call('POST', '/api/tunnels', {
  alias: 'mock-tunnel',
  hostName: 'x',
  forwards: [{ type: 'local', listenPort: 1, targetHost: 's', targetPort: 2 }],
})
check('重复别名 400', dup.status === 400 && /已存在/.test(dup.body.error))

const bad = await call('POST', '/api/tunnels', {
  alias: 'bad;rm',
  hostName: 'x',
  forwards: [{ type: 'local', listenPort: 1, targetHost: 's', targetPort: 2 }],
})
check('非法别名 400', bad.status === 400)

const delOk = await call('DELETE', '/api/tunnels/mock-tunnel')
check('DELETE 托管隧道', delOk.status === 200)

const delNo = await call('DELETE', '/api/tunnels/dev')
check('DELETE 非托管配置被拒', delNo.status === 400, delNo.body.error)

// 5) 连接增删（含通过隧道的连接：本地转发端口 / SOCKS ProxyCommand）
const addHost = await call('POST', '/api/hosts', {
  alias: 'prod-db',
  hostName: '127.0.0.1',
  user: 'postgres',
  port: 15432,
})
check('POST /api/hosts 直连/隧道端口连接', addHost.status === 200 && addHost.body.ok === true)

const addSocks = await call('POST', '/api/hosts', {
  alias: 'via-socks',
  hostName: '172.16.30.80',
  user: 'root',
  proxyCommand: 'nc -X 5 -x 127.0.0.1:1080 %h %p',
})
check('POST /api/hosts SOCKS 连接（ProxyCommand 含空格）', addSocks.status === 200 && addSocks.body.ok === true)

const hosts2 = await call('GET', '/api/hosts')
const viaSocks = hosts2.body.hosts.find((h) => h.alias === 'via-socks')
check('ProxyCommand 已解析回读', viaSocks?.proxyCommand === 'nc -X 5 -x 127.0.0.1:1080 %h %p')

const badProxy = await call('POST', '/api/hosts', {
  alias: 'evil',
  hostName: 'x',
  proxyCommand: 'nc x\nHost injected',
})
check('ProxyCommand 换行注入被拒', badProxy.status === 400)

const delHost = await call('DELETE', '/api/hosts/prod-db')
check('DELETE /api/hosts 托管连接', delHost.status === 200)
await call('DELETE', '/api/hosts/via-socks')

// 6) 更新配置（PUT）
// 手写块外科手术式修补：改 Port、加 IdentityFile、保留未知指令与注释
await call('POST', '/api/hosts', { alias: 'tmp-edit', hostName: '1.1.1.1' })
await call('DELETE', '/api/hosts/tmp-edit') // 确保不存在

const cfgPath = '/tmp/ssh-mgr-test/.ssh/config'
fs.appendFileSync(cfgPath, '\nHost legacy\n    HostName 10.1.1.1\n    User ops\n    Compression yes\n    # 手写注释\n')

const put1 = await call('PUT', '/api/hosts/legacy', { hostName: '10.1.1.2', user: 'ops', port: 2222, identityFile: '~/.ssh/id_rsa' })
check('PUT /api/hosts 手写块更新', put1.status === 200)
const afterPut = fs.readFileSync(cfgPath, 'utf8')
check('Port 已插入', /^\s*Port 2222$/m.test(afterPut))
check('HostName 已替换', afterPut.includes('HostName 10.1.1.2') && !afterPut.includes('HostName 10.1.1.1'))
check('未知指令保留', afterPut.includes('Compression yes'))
check('注释保留', afterPut.includes('# 手写注释'))

// 清除指令：user 传空串 → 删除 User 行
await call('PUT', '/api/hosts/legacy', { hostName: '10.1.1.2', user: '', port: 2222 })
const afterClear = fs.readFileSync(cfgPath, 'utf8')
check('空串清除 User 指令', !/^\s*User ops$/m.test(afterClear.split('Host legacy')[1] ?? ''))

// 隧道转发整体替换（手写隧道块）
const put2 = await call('PUT', '/api/tunnels/web-tunnel', {
  hostName: '192.168.1.5',
  forwards: [{ type: 'local', listenPort: 18000, targetHost: 'a.internal', targetPort: 8000, desc: '新描述' }],
})
check('PUT /api/tunnels 转发替换', put2.status === 200)
const webConf = fs.readFileSync('/tmp/ssh-mgr-test/.ssh/conf.d/web.conf', 'utf8')
check('旧转发已移除', !webConf.includes('RemoteForward'))
check('新转发已写入（含 Include 文件）', webConf.includes('LocalForward 18000 a.internal:8000'))
check('旧描述注释已清除', !webConf.includes('旧描述'))
check('新描述注释已写入', /^\s*# 新描述\n\s*LocalForward 18000/m.test(webConf))

// 托管隧道整段重生成，标记保留
const put3 = await call('PUT', '/api/tunnels/db-tunnel', {
  hostName: 'jump2.example.com',
  user: 'ops',
  forwards: [{ type: 'local', listenPort: 15433, targetHost: 'db2.internal', targetPort: 5432, desc: '主库转发' }],
})
check('PUT 托管隧道重生成', put3.status === 200)
check('标记保留', afterPut2().includes('# >>> ssh-mgr: db-tunnel') && afterPut2().includes('HostName jump2.example.com'))
check('托管块描述重生成且无旧注释残留', afterPut2().includes('# 主库转发') && !afterPut2().includes('# 生产库'))
function afterPut2() { return fs.readFileSync(cfgPath, 'utf8') }

// 更新不存在的别名
const putMissing = await call('PUT', '/api/hosts/no-such', { hostName: 'x' })
check('PUT 不存在别名 400', putMissing.status === 400)

console.log(fail === 0 ? 'ALL TESTS PASSED' : `${fail} TEST(S) FAILED`)
process.exit(fail === 0 ? 0 : 1)
