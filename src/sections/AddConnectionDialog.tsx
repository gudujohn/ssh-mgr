import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import type { HostEntry, TunnelEntry } from '@/types/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'

type Mode = 'direct' | 'tunnel'

// 隧道里可用于建连接的出口：本地转发（连 127.0.0.1:端口）+ 动态转发（SOCKS，走 ProxyCommand）
interface TunnelOutlet {
  key: string
  label: string
  kind: 'local' | 'dynamic'
  bind: string
  port: number
}

function collectOutlets(tunnels: TunnelEntry[]): TunnelOutlet[] {
  const out: TunnelOutlet[] = []
  for (const t of tunnels) {
    for (const f of t.forwards) {
      if (f.type === 'local' && f.localPort) {
        const bind = f.bind ?? '127.0.0.1'
        out.push({
          key: `${t.alias}|L|${f.localPort}`,
          label: `${t.alias} · ${bind}:${f.localPort} → ${f.remoteHost}:${f.remotePort}`,
          kind: 'local',
          bind,
          port: f.localPort,
        })
      } else if (f.type === 'dynamic' && f.localPort) {
        const bind = f.bind ?? '127.0.0.1'
        out.push({
          key: `${t.alias}|D|${f.localPort}`,
          label: `${t.alias} · SOCKS ${bind}:${f.localPort}`,
          kind: 'dynamic',
          bind,
          port: f.localPort,
        })
      }
    }
  }
  return out
}

export default function AddConnectionDialog({
  open,
  onOpenChange,
  onAdded,
  editTarget = null,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onAdded: () => void
  editTarget?: HostEntry | null
}) {
  const [mode, setMode] = useState<Mode>('direct')
  const [alias, setAlias] = useState('')
  const [hostName, setHostName] = useState('')
  const [user, setUser] = useState('')
  const [port, setPort] = useState('')
  const [identityFile, setIdentityFile] = useState('')
  const [proxyJump, setProxyJump] = useState('')
  const [proxyCommand, setProxyCommand] = useState('')
  const [outlets, setOutlets] = useState<TunnelOutlet[]>([])
  const [outletKey, setOutletKey] = useState('')
  const [loadingTunnels, setLoadingTunnels] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  // 编辑模式：打开时用现有配置回填表单（始终用直连字段布局，ProxyCommand 单独可编辑）
  useEffect(() => {
    if (!open) return
    if (editTarget) {
      setMode('direct')
      setAlias(editTarget.alias ?? '')
      setHostName(editTarget.hostName ?? '')
      setUser(editTarget.user ?? '')
      setPort(editTarget.port ?? '')
      setIdentityFile(editTarget.identityFile ?? '')
      setProxyJump(editTarget.proxyJump ?? '')
      setProxyCommand(editTarget.proxyCommand ?? '')
      setErrors({})
    } else {
      reset()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editTarget])

  // 打开对话框且选择隧道模式时加载隧道出口
  useEffect(() => {
    if (open && mode === 'tunnel') {
      setLoadingTunnels(true)
      api
        .tunnels()
        .then((r) => {
          const o = collectOutlets(r.tunnels)
          setOutlets(o)
          if (o.length > 0 && !o.some((x) => x.key === outletKey)) setOutletKey(o[0].key)
        })
        .catch((e) => toast.error(e instanceof Error ? e.message : '加载隧道失败'))
        .finally(() => setLoadingTunnels(false))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode])

  const outlet = outlets.find((o) => o.key === outletKey) ?? null

  const reset = () => {
    setMode('direct')
    setAlias('')
    setHostName('')
    setUser('')
    setPort('')
    setIdentityFile('')
    setProxyJump('')
    setProxyCommand('')
    setOutletKey('')
    setErrors({})
  }

  // 通过本地转发时：HostName/端口由隧道出口决定
  const effectiveHost = !editTarget && mode === 'tunnel' && outlet?.kind === 'local' ? outlet.bind : hostName.trim()
  const effectivePort = !editTarget && mode === 'tunnel' && outlet?.kind === 'local' ? String(outlet.port) : port.trim()
  // 通过 SOCKS 动态转发时：生成 ProxyCommand（macOS/Linux 自带 BSD nc）
  const effectiveProxyCommand = editTarget
    ? proxyCommand.trim() || ''
    : mode === 'tunnel' && outlet?.kind === 'dynamic'
      ? `nc -X 5 -x ${outlet.bind}:${outlet.port} %h %p`
      : ''

  const preview = useMemo(() => {
    const lines = [`Host ${alias || '<别名>'}`]
    if (effectiveHost) lines.push(`    HostName ${effectiveHost}`)
    if (user) lines.push(`    User ${user}`)
    if (effectivePort) lines.push(`    Port ${effectivePort}`)
    if (identityFile) lines.push(`    IdentityFile ${identityFile}`)
    if (mode === 'direct' && proxyJump) lines.push(`    ProxyJump ${proxyJump}`)
    if (effectiveProxyCommand) lines.push(`    ProxyCommand ${effectiveProxyCommand}`)
    return lines.join('\n')
  }, [alias, effectiveHost, user, effectivePort, identityFile, proxyJump, effectiveProxyCommand, mode])

  const validate = (): boolean => {
    const e: Record<string, string> = {}
    if (!/^[A-Za-z0-9._-]+$/.test(alias.trim())) e.alias = '必填，仅限字母、数字、点、下划线、横线'
    if (editTarget || mode === 'direct' || outlet?.kind === 'dynamic') {
      if (!hostName.trim()) e.hostName = '必填'
    }
    if (!editTarget && mode === 'tunnel' && !outlet) e.outlet = outlets.length === 0 ? '没有可用的隧道出口（需要含本地/动态转发的隧道）' : '请选择隧道出口'
    if ((editTarget || mode === 'direct') && port.trim()) {
      const p = Number(port)
      if (!Number.isInteger(p) || p < 1 || p > 65535) e.port = '端口需在 1-65535 之间'
    }
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const submit = async () => {
    if (!validate()) return
    setSaving(true)
    try {
      if (editTarget) {
        // 编辑：空字符串表示删除该指令
        await api.updateHost(editTarget.alias!, {
          hostName: hostName.trim(),
          user: user.trim(),
          port: port.trim() ? Number(port) : '',
          identityFile: identityFile.trim(),
          proxyJump: proxyJump.trim(),
          proxyCommand: proxyCommand.trim(),
        })
        toast.success(`连接 ${editTarget.alias} 已更新`)
      } else {
        await api.addHost({
          alias: alias.trim(),
          hostName: effectiveHost,
          user: user.trim() || undefined,
          port: effectivePort ? Number(effectivePort) : undefined,
          identityFile: identityFile.trim() || undefined,
          proxyJump: mode === 'direct' ? proxyJump.trim() || undefined : undefined,
          proxyCommand: effectiveProxyCommand || undefined,
        })
        toast.success(`连接 ${alias} 已写入 ~/.ssh/config`)
      }
      onOpenChange(false)
      reset()
      onAdded()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editTarget ? `编辑连接：${editTarget.alias}` : '新增连接'}</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          {editTarget
            ? editTarget.managed
              ? '该配置由本工具创建，保存时将整段重新生成。'
              : `该配置位于 ${editTarget.source}，保存时仅修改上述指令行，块内其他内容原样保留。`
            : '将以 Host 块的形式追加到 ~/.ssh/config（带 ssh-mgr 标记，可随时删除）。'}
        </p>

        {!editTarget && (
        <div className="space-y-1.5">
          <Label>连接方式</Label>
          <RadioGroup
            className="flex gap-4"
            value={mode}
            onValueChange={(v) => setMode(v as Mode)}
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem value="direct" id="mode-direct" />
              <Label htmlFor="mode-direct" className="font-normal">直连 / 跳板</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="tunnel" id="mode-tunnel" />
              <Label htmlFor="mode-tunnel" className="font-normal">通过已有隧道</Label>
            </div>
          </RadioGroup>
        </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
          <div className="space-y-1.5">
            <Label>
              别名<span className="text-destructive"> *</span>
            </Label>
            <Input
              placeholder="例如 prod-db"
              value={alias}
              disabled={!!editTarget}
              onChange={(e) => {
                setAlias(e.target.value)
                setErrors((p) => ({ ...p, alias: '' }))
              }}
            />
            {errors.alias && <p className="text-xs text-destructive">{errors.alias}</p>}
          </div>

          {!editTarget && mode === 'tunnel' && (
            <div className="space-y-1.5">
              <Label>
                隧道出口<span className="text-destructive"> *</span>
              </Label>
              <Select value={outletKey} onValueChange={setOutletKey} disabled={loadingTunnels || outlets.length === 0}>
                <SelectTrigger>
                  <SelectValue placeholder={loadingTunnels ? '加载中…' : outlets.length === 0 ? '无可用隧道出口' : '选择隧道出口'} />
                </SelectTrigger>
                <SelectContent>
                  {outlets.map((o) => (
                    <SelectItem key={o.key} value={o.key}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.outlet && <p className="text-xs text-destructive">{errors.outlet}</p>}
            </div>
          )}

          {/* 本地转发出口：HostName/端口自动锁定为隧道本地监听地址 */}
          {!editTarget && mode === 'tunnel' && outlet?.kind === 'local' ? (
            <div className="space-y-1.5 sm:col-span-2">
              <Label>目标地址（由隧道出口决定）</Label>
              <div className="rounded-md border bg-muted px-3 py-2 font-mono text-sm">
                {outlet.bind}:{outlet.port}
              </div>
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label>
                  主机 (HostName){mode === 'direct' && <span className="text-destructive"> *</span>}
                  {mode === 'tunnel' && <span className="text-destructive"> *</span>}
                </Label>
                <Input
                  placeholder={mode === 'tunnel' ? '隧道对端网络中的真实主机' : '例如 10.0.0.10 或 db.example.com'}
                  value={hostName}
                  onChange={(e) => {
                    setHostName(e.target.value)
                    setErrors((p) => ({ ...p, hostName: '' }))
                  }}
                />
                {errors.hostName && <p className="text-xs text-destructive">{errors.hostName}</p>}
              </div>
              <div className="space-y-1.5">
                <Label>SSH 端口 (Port)</Label>
                <Input
                  placeholder="默认 22"
                  inputMode="numeric"
                  value={port}
                  onChange={(e) => {
                    setPort(e.target.value)
                    setErrors((p) => ({ ...p, port: '' }))
                  }}
                />
                {errors.port && <p className="text-xs text-destructive">{errors.port}</p>}
              </div>
            </>
          )}

          <div className="space-y-1.5">
            <Label>用户 (User)</Label>
            <Input placeholder="默认当前用户" value={user} onChange={(e) => setUser(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>私钥 (IdentityFile)</Label>
            <Input placeholder="例如 ~/.ssh/id_ed25519" value={identityFile} onChange={(e) => setIdentityFile(e.target.value)} />
          </div>
          {(mode === 'direct' || !!editTarget) && (
            <div className="space-y-1.5 sm:col-span-2">
              <Label>跳板 (ProxyJump)</Label>
              <Input placeholder="例如 bastion（可选）" value={proxyJump} onChange={(e) => setProxyJump(e.target.value)} />
            </div>
          )}
          {!!editTarget && (
            <div className="space-y-1.5 sm:col-span-2">
              <Label>ProxyCommand（经 SOCKS 隧道的连接会有，清空即删除该指令）</Label>
              <Input
                placeholder="例如 nc -X 5 -x 127.0.0.1:1080 %h %p"
                value={proxyCommand}
                onChange={(e) => setProxyCommand(e.target.value)}
              />
            </div>
          )}
          {!editTarget && mode === 'tunnel' && outlet?.kind === 'dynamic' && (
            <p className="text-xs text-muted-foreground sm:col-span-2">
              动态转发为 SOCKS5 代理，将生成 ProxyCommand（nc -X 5 …），需要系统自带 nc（macOS/Linux 支持，Windows 不适用）。
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label className="text-muted-foreground">配置预览（写入 ~/.ssh/config）</Label>
          <pre className="rounded-md bg-muted p-3 text-xs font-mono whitespace-pre-wrap break-all leading-relaxed">
            {preview}
          </pre>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? '保存中…' : editTarget ? '保存修改' : '写入配置'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
