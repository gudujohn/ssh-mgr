import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Square,
  TerminalSquare,
  Trash2,
} from 'lucide-react'
import { api, type TunnelsResponse } from '@/lib/api'
import type { ForwardRule, TunnelEntry, TunnelState } from '@/types/api'
import AddTunnelDialog from '@/sections/AddTunnelDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

const STATE_META: Record<TunnelState, { label: string; className: string }> = {
  running: { label: '运行中', className: 'bg-green-600/15 text-green-700 border-green-600/30' },
  external: { label: '运行中（外部）', className: 'bg-blue-600/15 text-blue-700 border-blue-600/30' },
  stopped: { label: '已停止', className: 'bg-muted text-muted-foreground' },
  error: { label: '异常', className: 'bg-red-600/15 text-red-700 border-red-600/30' },
}

// 单条转发的文本描述（搜索/展示共用）
function forwardText(f: ForwardRule): string {
  if (f.type === 'dynamic') return `SOCKS ${f.bind ?? '127.0.0.1'}:${f.localPort}`
  const listen = f.type === 'local' ? f.localPort : f.remoteListenPort
  return `${f.bind ? `${f.bind}:` : ''}${listen} → ${f.remoteHost}:${f.remotePort}`
}

function ForwardBadges({ f }: { f: ForwardRule }) {
  const label = f.type === 'local' ? '本地' : f.type === 'remote' ? '远程' : 'SOCKS'
  return <Badge variant="outline">{label}</Badge>
}

const SEL_STORAGE_KEY = 'ssh-mgr:forward-selection'

function loadSelections(): Record<string, number[]> {
  try {
    return JSON.parse(localStorage.getItem(SEL_STORAGE_KEY) ?? '{}')
  } catch {
    return {}
  }
}

// 转发勾选列表：少（≤4）直接平铺；多则可折叠、可搜索、可全选
function ForwardSelector({
  tunnel,
  selected,
  onChange,
}: {
  tunnel: TunnelEntry
  selected: number[]
  onChange: (ids: number[]) => void
}) {
  const total = tunnel.forwards.length
  const [open, setOpen] = useState(total <= 4)
  const [query, setQuery] = useState('')

  const toggle = (i: number) => {
    onChange(selected.includes(i) ? selected.filter((x) => x !== i) : [...selected, i].sort((a, b) => a - b))
  }

  const visible = tunnel.forwards
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => !query.trim() || forwardText(f).toLowerCase().includes(query.trim().toLowerCase()))

  const portStatusOf = (f: ForwardRule) =>
    f.type === 'local' || f.type === 'dynamic'
      ? tunnel.state.ports.find((p) => p.port === f.localPort)
      : undefined

  const running = tunnel.state.status !== 'stopped'
  const activeIds = tunnel.state.activeForwardIds ?? []

  return (
    <div className="rounded-md border">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-xs text-muted-foreground">
          转发规则（启用 {selected.length}/{total}）
        </span>
        {total > 4 && (
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => onChange(tunnel.forwards.map((_, i) => i))}>
              全选
            </Button>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => onChange([])}>
              清空
            </Button>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setOpen(!open)}>
              {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </Button>
          </div>
        )}
      </div>

      {open && (
        <div className="border-t px-3 py-2 space-y-2">
          {total > 4 && (
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                className="h-7 pl-8 text-xs"
                placeholder="搜索端口 / 目标…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          )}
          <ul className={`space-y-1 ${total > 4 ? 'max-h-44 overflow-y-auto pr-1' : ''}`}>
            {visible.map(({ f, i }) => {
              const ps = portStatusOf(f)
              return (
                <li key={i}>
                  <label className="flex items-center gap-2 cursor-pointer rounded px-1 py-0.5 hover:bg-muted/60">
                    <Checkbox checked={selected.includes(i)} onCheckedChange={() => toggle(i)} />
                    {ps && (
                      <span
                        className={`inline-block h-2 w-2 rounded-full shrink-0 ${ps.ok ? 'bg-green-500' : 'bg-red-500'}`}
                        title={ps.ok ? '本地端口可连通' : '本地端口不可连通'}
                      />
                    )}
                    <ForwardBadges f={f} />
                    <span className="font-mono text-xs flex items-center gap-1 min-w-0">
                      {f.type === 'dynamic' ? (
                        `${f.bind ?? '127.0.0.1'}:${f.localPort}`
                      ) : (
                        <>
                          {f.bind ? `${f.bind}:` : ''}
                          {f.type === 'local' ? f.localPort : f.remoteListenPort}
                          <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                          <span className="truncate">{f.remoteHost}:{f.remotePort}</span>
                        </>
                      )}
                    </span>
                    {running && !activeIds.includes(i) && (
                      <span className="text-[10px] text-muted-foreground shrink-0">（未启用）</span>
                    )}
                  </label>
                </li>
              )
            })}
            {visible.length === 0 && (
              <li className="text-xs text-muted-foreground py-1">无匹配的转发规则</li>
            )}
          </ul>
        </div>
      )}
    </div>
  )
}

export default function TunnelsSection() {
  const [data, setData] = useState<TunnelsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<TunnelEntry | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [selections, setSelections] = useState<Record<string, number[]>>(loadSelections)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      setData(await api.tunnels())
    } catch (e) {
      if (!silent) toast.error(e instanceof Error ? e.message : '加载失败')
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  // 场景①：进入页面全量加载；场景③：停留期间每 5 秒轮询（可暂停）
  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (autoRefresh) {
      timerRef.current = setInterval(() => load(true), 5000)
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [autoRefresh, load])

  // 选中转发的读取与持久化（localStorage）
  const getSelected = (t: TunnelEntry): number[] => {
    const stored = selections[t.alias ?? '']
    if (!stored) return t.forwards.map((_, i) => i)
    return stored.filter((i) => i >= 0 && i < t.forwards.length)
  }
  const setSelected = (alias: string, ids: number[]) => {
    setSelections((prev) => {
      const next = { ...prev, [alias]: ids }
      localStorage.setItem(SEL_STORAGE_KEY, JSON.stringify(next))
      return next
    })
  }

  // 场景②：启动/停止操作后立即复查状态
  const act = async (t: TunnelEntry, action: 'start' | 'stop') => {
    const alias = t.alias!
    const sel = getSelected(t)
    if (action === 'start' && sel.length === 0) {
      toast.error('请至少勾选一条转发规则')
      return
    }
    setBusy(alias)
    try {
      if (action === 'start') {
        await api.startTunnel(alias, sel)
        toast.success(`隧道 ${alias} 已启动（${sel.length} 条转发）`)
      } else {
        await api.stopTunnel(alias)
        toast.success(`隧道 ${alias} 已停止`)
      }
      await load(true)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败')
    } finally {
      setBusy(null)
    }
  }

  // 在系统终端中启动（密码/动态口令等交互认证场景，如 JumpServer）
  const startInTerminal = async (t: TunnelEntry) => {
    const alias = t.alias!
    const sel = getSelected(t)
    if (sel.length === 0) {
      toast.error('请至少勾选一条转发规则')
      return
    }
    setBusy(alias)
    try {
      const r = await api.startTunnelInTerminal(alias, sel)
      toast.success(`已在 ${r.terminal} 中打开（会话保持期间隧道生效）`, { description: r.command })
      setTimeout(() => load(true), 3000)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '打开终端失败')
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    if (!deleteTarget) return
    try {
      await api.removeTunnel(deleteTarget)
      toast.success(`已从 ~/.ssh/config 移除 ${deleteTarget}`)
      setDeleteTarget(null)
      await load(true)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败')
    }
  }

  const tunnels = data?.tunnels ?? []

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4 mr-1" /> 新增隧道
        </Button>
        <Button variant="outline" size="sm" onClick={() => load()} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-1 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </Button>
        <div className="flex items-center gap-2 ml-auto">
          <Switch id="auto-refresh" checked={autoRefresh} onCheckedChange={setAutoRefresh} />
          <Label htmlFor="auto-refresh" className="text-sm text-muted-foreground">
            自动刷新状态（5s）
          </Label>
        </div>
      </div>

      {data && !data.configExists && (
        <p className="text-sm text-muted-foreground">未找到 SSH 配置文件（~/.ssh/config）。</p>
      )}
      {data?.errors.map((e) => (
        <p key={e} className="text-sm text-destructive">{e}</p>
      ))}

      {tunnels.length === 0 && !loading && (
        <div className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
          暂无隧道配置。隧道 = ssh config 中含 LocalForward / RemoteForward / DynamicForward 的 Host 块。
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {tunnels.map((t: TunnelEntry) => {
          const meta = STATE_META[t.state.status]
          const running = t.state.status === 'running' || t.state.status === 'external' || t.state.status === 'error'
          const sel = getSelected(t)
          return (
            <Card key={`${t.source}:${t.alias}`}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="font-mono text-base">{t.alias}</CardTitle>
                  <Badge variant="outline" className={meta.className}>
                    {meta.label}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground font-mono">
                  {t.user ? `${t.user}@` : ''}
                  {t.hostName ?? '?'}
                  {t.port ? `:${t.port}` : ''}
                </p>
              </CardHeader>
              <CardContent className="space-y-3">
                <ForwardSelector
                  tunnel={t}
                  selected={sel}
                  onChange={(ids) => setSelected(t.alias!, ids)}
                />
                {running && (
                  <p className="text-xs text-muted-foreground">勾选变化将在下次启动时生效</p>
                )}

                {t.state.processes.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    进程 PID: {t.state.processes.map((p) => p.pid).join(', ')}
                  </p>
                )}
                {t.state.status === 'error' && t.state.lastError && (
                  <p className="text-xs text-destructive break-all">{t.state.lastError}</p>
                )}

                <div className="flex items-center gap-2 pt-1">
                  {running ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy === t.alias}
                      onClick={() => act(t, 'stop')}
                    >
                      <Square className="h-3.5 w-3.5 mr-1" /> 停止
                    </Button>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        disabled={busy === t.alias || sel.length === 0}
                        onClick={() => act(t, 'start')}
                      >
                        <Play className="h-3.5 w-3.5 mr-1" /> 启动
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        title="在系统终端中执行 ssh 会话，适用于需要密码/动态口令交互认证、或不支持 -N 的堡垒机（如部分 JumpServer 版本）；会话保持期间隧道生效"
                        disabled={busy === t.alias || sel.length === 0}
                        onClick={() => startInTerminal(t)}
                      >
                        <TerminalSquare className="h-3.5 w-3.5 mr-1" /> 终端启动
                      </Button>
                    </>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy === t.alias}
                    onClick={() => setEditTarget(t)}
                  >
                    <Pencil className="h-3.5 w-3.5 mr-1" /> 编辑
                  </Button>
                  {t.managed && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      disabled={running || busy === t.alias}
                      onClick={() => setDeleteTarget(t.alias)}
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-1" /> 删除配置
                    </Button>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {t.state.checkedAt
                      ? `更新于 ${new Date(t.state.checkedAt).toLocaleTimeString()}`
                      : ''}
                  </span>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      <AddTunnelDialog open={addOpen} onOpenChange={setAddOpen} onAdded={() => load(true)} />

      {/* 编辑对话框：editTarget 变化时重挂载表单（key 保证回填生效） */}
      {editTarget && (
        <AddTunnelDialog
          key={editTarget.alias}
          open
          onOpenChange={(v) => !v && setEditTarget(null)}
          onAdded={() => {
            setEditTarget(null)
            load(true)
          }}
          editTarget={editTarget}
        />
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除隧道配置</AlertDialogTitle>
            <AlertDialogDescription>
              将从 ~/.ssh/config 中移除 Host 块「{deleteTarget}」（仅限本工具添加的带标记块），此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={remove}>确认删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
