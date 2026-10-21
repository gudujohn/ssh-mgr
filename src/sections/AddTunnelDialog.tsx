import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Plus, X } from 'lucide-react'
import { api } from '@/lib/api'
import type { TunnelEntry } from '@/types/api'
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

interface ForwardDraft {
  type: 'local' | 'remote' | 'dynamic'
  bind: string
  listenPort: string
  targetHost: string
  targetPort: string
}

const emptyForward = (): ForwardDraft => ({
  type: 'local',
  bind: '',
  listenPort: '',
  targetHost: '',
  targetPort: '',
})

const TYPE_META: Record<ForwardDraft['type'], { name: string; hint: string; listenLabel: string }> = {
  local: {
    name: '本地转发 (-L)',
    hint: '访问本机监听端口 ⇒ 经 SSH 主机转发到目标',
    listenLabel: '本地端口',
  },
  remote: {
    name: '远程转发 (-R)',
    hint: '访问 SSH 主机上的监听端口 ⇒ 回转到本机可达的目标',
    listenLabel: '远程端口',
  },
  dynamic: {
    name: '动态转发 (-D)',
    hint: '在本机监听端口上开启 SOCKS5 代理，流量经 SSH 主机出口',
    listenLabel: '本地端口',
  },
}

function Field({
  label,
  required,
  error,
  children,
  className,
}: {
  label: string
  required?: boolean
  error?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={`space-y-1.5 ${className ?? ''}`}>
      <Label className={error ? 'text-destructive' : ''}>
        {label}
        {required && <span className="text-destructive"> *</span>}
      </Label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

export default function AddTunnelDialog({
  open,
  onOpenChange,
  onAdded,
  editTarget = null,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onAdded: () => void
  editTarget?: TunnelEntry | null
}) {
  const [alias, setAlias] = useState('')
  const [hostName, setHostName] = useState('')
  const [user, setUser] = useState('')
  const [port, setPort] = useState('')
  const [identityFile, setIdentityFile] = useState('')
  const [proxyJump, setProxyJump] = useState('')
  const [forwards, setForwards] = useState<ForwardDraft[]>([emptyForward()])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  // 编辑模式：打开时用现有配置回填表单
  useEffect(() => {
    if (!open) return
    if (editTarget) {
      setAlias(editTarget.alias ?? '')
      setHostName(editTarget.hostName ?? '')
      setUser(editTarget.user ?? '')
      setPort(editTarget.port ?? '')
      setIdentityFile(editTarget.identityFile ?? '')
      setProxyJump(editTarget.proxyJump ?? '')
      setForwards(
        editTarget.forwards.length > 0
          ? editTarget.forwards.map((f) => ({
              type: f.type,
              bind: f.bind ?? '',
              listenPort: String(f.type === 'remote' ? f.remoteListenPort ?? '' : f.localPort ?? ''),
              targetHost: f.remoteHost ?? '',
              targetPort: f.remotePort != null ? String(f.remotePort) : '',
            }))
          : [emptyForward()]
      )
      setErrors({})
    } else {
      reset()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editTarget])

  const reset = () => {
    setAlias('')
    setHostName('')
    setUser('')
    setPort('')
    setIdentityFile('')
    setProxyJump('')
    setForwards([emptyForward()])
    setErrors({})
  }

  // 实时预览将写入 ~/.ssh/config 的 Host 块
  const preview = useMemo(() => {
    const lines = [`Host ${alias || '<别名>'}`]
    if (hostName) lines.push(`    HostName ${hostName}`)
    if (user) lines.push(`    User ${user}`)
    if (port) lines.push(`    Port ${port}`)
    if (identityFile) lines.push(`    IdentityFile ${identityFile}`)
    if (proxyJump) lines.push(`    ProxyJump ${proxyJump}`)
    for (const f of forwards) {
      const listen = f.bind ? `${f.bind}:${f.listenPort || '?'}` : f.listenPort || '?'
      if (f.type === 'local') {
        lines.push(`    LocalForward ${listen} ${f.targetHost || '?'}:${f.targetPort || '?'}`)
      } else if (f.type === 'remote') {
        lines.push(`    RemoteForward ${listen} ${f.targetHost || '?'}:${f.targetPort || '?'}`)
      } else {
        lines.push(`    DynamicForward ${listen}`)
      }
    }
    return lines.join('\n')
  }, [alias, hostName, user, port, identityFile, proxyJump, forwards])

  const validate = (): boolean => {
    const e: Record<string, string> = {}
    if (!/^[A-Za-z0-9._-]+$/.test(alias.trim())) {
      e.alias = '必填，仅限字母、数字、点、下划线、横线'
    }
    if (!hostName.trim()) e.hostName = '必填'
    if (port.trim()) {
      const p = Number(port)
      if (!Number.isInteger(p) || p < 1 || p > 65535) e.port = '端口需在 1-65535 之间'
    }
    forwards.forEach((f, i) => {
      const lp = Number(f.listenPort)
      if (!Number.isInteger(lp) || lp < 1 || lp > 65535) {
        e[`f${i}.listenPort`] = '1-65535'
      }
      if (f.type !== 'dynamic') {
        if (!f.targetHost.trim()) e[`f${i}.targetHost`] = '必填'
        const tp = Number(f.targetPort)
        if (!Number.isInteger(tp) || tp < 1 || tp > 65535) e[`f${i}.targetPort`] = '1-65535'
      }
    })
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const submit = async () => {
    if (!validate()) return
    setSaving(true)
    const forwardsPayload = forwards.map((f) => ({
      type: f.type,
      bind: f.bind.trim() || undefined,
      listenPort: Number(f.listenPort),
      targetHost: f.targetHost.trim() || undefined,
      targetPort: f.targetPort.trim() ? Number(f.targetPort) : undefined,
    }))
    try {
      if (editTarget) {
        // 编辑：空字符串表示删除该指令（如清空 User / Port）
        await api.updateTunnel(editTarget.alias!, {
          hostName: hostName.trim(),
          user: user.trim(),
          port: port.trim() ? Number(port) : '',
          identityFile: identityFile.trim(),
          proxyJump: proxyJump.trim(),
          forwards: forwardsPayload,
        })
        toast.success(`隧道 ${editTarget.alias} 已更新`)
      } else {
        await api.addTunnel({
          alias: alias.trim(),
          hostName: hostName.trim(),
          user: user.trim() || undefined,
          port: port.trim() ? Number(port) : undefined,
          identityFile: identityFile.trim() || undefined,
          proxyJump: proxyJump.trim() || undefined,
          forwards: forwardsPayload,
        })
        toast.success(`隧道 ${alias} 已写入 ~/.ssh/config`)
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

  const updateForward = (i: number, patch: Partial<ForwardDraft>) => {
    setForwards((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)))
    // 修改即清除对应错误
    setErrors((prev) => {
      const next = { ...prev }
      for (const k of Object.keys(next)) if (k.startsWith(`f${i}.`)) delete next[k]
      return next
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editTarget ? `编辑隧道：${editTarget.alias}` : '新增隧道'}</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          {editTarget
            ? editTarget.managed
              ? '该配置由本工具创建，保存时将整段重新生成。'
              : `该配置位于 ${editTarget.source}，保存时仅修改上述指令行，块内其他内容（注释、其他选项）原样保留。`
            : '将以 Host 块的形式追加到 ~/.ssh/config（带 ssh-mgr 标记，可随时删除），工具不维护独立配置。'}
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
          <Field label="别名" required error={errors.alias}>
            <Input
              placeholder="例如 db-tunnel（启动命令: ssh -N 别名）"
              value={alias}
              disabled={!!editTarget}
              onChange={(e) => {
                setAlias(e.target.value)
                setErrors((p) => ({ ...p, alias: '' }))
              }}
            />
          </Field>
          <Field label="主机 (HostName)" required error={errors.hostName}>
            <Input
              placeholder="例如 10.0.0.8 或 jump.example.com"
              value={hostName}
              onChange={(e) => {
                setHostName(e.target.value)
                setErrors((p) => ({ ...p, hostName: '' }))
              }}
            />
          </Field>
          <Field label="用户 (User)">
            <Input placeholder="默认当前用户" value={user} onChange={(e) => setUser(e.target.value)} />
          </Field>
          <Field label="SSH 端口 (Port)" error={errors.port}>
            <Input
              placeholder="默认 22"
              inputMode="numeric"
              value={port}
              onChange={(e) => {
                setPort(e.target.value)
                setErrors((p) => ({ ...p, port: '' }))
              }}
            />
          </Field>
          <Field label="私钥 (IdentityFile)">
            <Input
              placeholder="例如 ~/.ssh/id_ed25519"
              value={identityFile}
              onChange={(e) => setIdentityFile(e.target.value)}
            />
          </Field>
          <Field label="跳板 (ProxyJump)">
            <Input placeholder="例如 bastion（可选）" value={proxyJump} onChange={(e) => setProxyJump(e.target.value)} />
          </Field>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label>
              转发规则<span className="text-destructive"> *</span>
            </Label>
            <Button variant="outline" size="sm" onClick={() => setForwards((fs) => [...fs, emptyForward()])}>
              <Plus className="h-4 w-4 mr-1" /> 添加规则
            </Button>
          </div>

          {forwards.map((f, i) => {
            const meta = TYPE_META[f.type]
            return (
              <div key={i} className="relative rounded-md border p-3 space-y-3">
                <div className="flex items-center gap-3">
                  <Select
                    value={f.type}
                    onValueChange={(v) => updateForward(i, { type: v as ForwardDraft['type'] })}
                  >
                    <SelectTrigger className="w-[170px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="local">{TYPE_META.local.name}</SelectItem>
                      <SelectItem value="remote">{TYPE_META.remote.name}</SelectItem>
                      <SelectItem value="dynamic">{TYPE_META.dynamic.name}</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground flex-1">{meta.hint}</p>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0 h-8 w-8"
                    disabled={forwards.length === 1}
                    onClick={() => setForwards((fs) => fs.filter((_, j) => j !== i))}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <Field label="绑定地址">
                    <Input
                      placeholder="127.0.0.1"
                      value={f.bind}
                      onChange={(e) => updateForward(i, { bind: e.target.value })}
                    />
                  </Field>
                  <Field label={meta.listenLabel} required error={errors[`f${i}.listenPort`]}>
                    <Input
                      placeholder={f.type === 'dynamic' ? '1080' : '8080'}
                      inputMode="numeric"
                      value={f.listenPort}
                      onChange={(e) => updateForward(i, { listenPort: e.target.value })}
                    />
                  </Field>
                  {f.type !== 'dynamic' && (
                    <>
                      <Field label="目标主机" required error={errors[`f${i}.targetHost`]}>
                        <Input
                          placeholder={f.type === 'local' ? 'db.internal' : 'localhost'}
                          value={f.targetHost}
                          onChange={(e) => updateForward(i, { targetHost: e.target.value })}
                        />
                      </Field>
                      <Field label="目标端口" required error={errors[`f${i}.targetPort`]}>
                        <Input
                          placeholder={f.type === 'local' ? '5432' : '9000'}
                          inputMode="numeric"
                          value={f.targetPort}
                          onChange={(e) => updateForward(i, { targetPort: e.target.value })}
                        />
                      </Field>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        <div className="space-y-1.5">
          <Label className="text-muted-foreground">配置预览（写入 ~/.ssh/config）</Label>
          <pre className="rounded-md bg-muted p-3 text-xs font-mono whitespace-pre-wrap break-all leading-relaxed">
            {preview}
          </pre>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? '保存中…' : editTarget ? '保存修改' : '写入配置'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
