import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Cable, Pencil, Plus, RefreshCw, Search, TerminalSquare, Trash2 } from 'lucide-react'
import { api, type HostsResponse } from '@/lib/api'
import type { HostEntry } from '@/types/api'
import AddConnectionDialog from '@/sections/AddConnectionDialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
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

export default function ConnectionsSection() {
  const [data, setData] = useState<HostsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [keyword, setKeyword] = useState('')
  const [connecting, setConnecting] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<HostEntry | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await api.hosts())
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const connect = async (host: HostEntry) => {
    if (!host.alias) return
    setConnecting(host.alias)
    try {
      const r = await api.connect(host.alias)
      toast.success(`已在 ${r.terminal} 中打开`, { description: r.command })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '打开终端失败')
    } finally {
      setConnecting(null)
    }
  }

  const remove = async () => {
    if (!deleteTarget) return
    try {
      await api.removeHost(deleteTarget)
      toast.success(`已从 ~/.ssh/config 移除 ${deleteTarget}`)
      setDeleteTarget(null)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败')
    }
  }

  const hosts = (data?.hosts ?? []).filter((h) => {
    if (!keyword.trim()) return true
    const k = keyword.toLowerCase()
    return [h.alias, h.hostName, h.user, h.proxyJump, h.proxyCommand]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(k))
  })

  const viaTunnel = (h: HostEntry) =>
    h.proxyCommand != null ||
    (h.hostName != null &&
      ['127.0.0.1', 'localhost', '::1'].includes(h.hostName) &&
      h.port != null)

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="搜索别名 / 主机 / 用户…"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
        <Button onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4 mr-1" /> 新增连接
        </Button>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-1 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </Button>
      </div>

      {data && !data.configExists && (
        <p className="text-sm text-muted-foreground">未找到 SSH 配置文件（~/.ssh/config）。</p>
      )}
      {data?.errors.map((e) => (
        <p key={e} className="text-sm text-destructive">{e}</p>
      ))}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>别名</TableHead>
              <TableHead>主机</TableHead>
              <TableHead>用户</TableHead>
              <TableHead>端口</TableHead>
              <TableHead>经由</TableHead>
              <TableHead>转发</TableHead>
              <TableHead className="w-[170px]">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {hosts.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground py-10">
                  {loading ? '加载中…' : '没有可连接的 Host 配置'}
                </TableCell>
              </TableRow>
            )}
            {hosts.map((h) => (
              <TableRow key={`${h.source}:${h.alias}`}>
                <TableCell className="font-mono font-medium">{h.alias}</TableCell>
                <TableCell className="font-mono text-muted-foreground">
                  {h.hostName ?? '—'}
                </TableCell>
                <TableCell>{h.user ?? '—'}</TableCell>
                <TableCell>{h.port ?? '22'}</TableCell>
                <TableCell>
                  {h.proxyCommand ? (
                    <Badge variant="secondary" title={h.proxyCommand}>SOCKS 隧道</Badge>
                  ) : viaTunnel(h) ? (
                    <Badge variant="secondary">本地隧道</Badge>
                  ) : h.proxyJump ? (
                    <span className="font-mono text-xs">跳板 {h.proxyJump}</span>
                  ) : (
                    '直连'
                  )}
                </TableCell>
                <TableCell>
                  {h.isTunnel ? (
                    <Badge variant="secondary" className="gap-1">
                      <Cable className="h-3 w-3" />
                      {h.forwards.length}
                    </Badge>
                  ) : (
                    '—'
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={connecting === h.alias}
                      onClick={() => connect(h)}
                    >
                      <TerminalSquare className="h-4 w-4 mr-1" />
                      连接
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="px-2"
                      title="编辑配置"
                      onClick={() => setEditTarget(h)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    {h.managed && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive px-2"
                        onClick={() => setDeleteTarget(h.alias)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <AddConnectionDialog open={addOpen} onOpenChange={setAddOpen} onAdded={load} />

      {/* 编辑对话框：editTarget 变化时重挂载表单（key 保证回填生效） */}
      {editTarget && (
        <AddConnectionDialog
          key={editTarget.alias}
          open
          onOpenChange={(v) => !v && setEditTarget(null)}
          onAdded={() => {
            setEditTarget(null)
            load()
          }}
          editTarget={editTarget}
        />
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除连接配置</AlertDialogTitle>
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
