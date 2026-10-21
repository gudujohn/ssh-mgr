import type { ApiInfo, HostEntry, TunnelEntry, TunnelStatus } from '@/types/api'

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `请求失败 (${res.status})`)
  return data as T
}

export interface HostsResponse {
  hosts: HostEntry[]
  errors: string[]
  configExists: boolean
}

export interface TunnelsResponse {
  tunnels: TunnelEntry[]
  errors: string[]
  configExists: boolean
}

export const api = {
  info: () => req<ApiInfo>('/api/info'),
  hosts: () => req<HostsResponse>('/api/hosts'),
  tunnels: () => req<TunnelsResponse>('/api/tunnels'),
  tunnelStatus: (alias: string) =>
    req<TunnelStatus>(`/api/tunnels/${encodeURIComponent(alias)}/status`),
  connect: (alias: string) =>
    req<{ terminal: string; command: string }>('/api/connect', { method: 'POST', body: JSON.stringify({ alias }) }),
  startTunnel: (alias: string, forwardIds?: number[]) =>
    req<{ pid: number; state: TunnelStatus }>(`/api/tunnels/${encodeURIComponent(alias)}/start`, {
      method: 'POST',
      body: JSON.stringify({ forwardIds: forwardIds ?? null }),
    }),
  startTunnelInTerminal: (alias: string, forwardIds?: number[]) =>
    req<{ terminal: string; command: string }>(`/api/tunnels/${encodeURIComponent(alias)}/start-terminal`, {
      method: 'POST',
      body: JSON.stringify({ forwardIds: forwardIds ?? null }),
    }),
  stopTunnel: (alias: string) =>
    req<{ killed: number[] }>(`/api/tunnels/${encodeURIComponent(alias)}/stop`, { method: 'POST' }),
  addTunnel: (payload: {
    alias: string
    hostName: string
    user?: string
    port?: number
    identityFile?: string
    proxyJump?: string
    forwards: {
      type: 'local' | 'remote' | 'dynamic'
      bind?: string
      listenPort: number
      targetHost?: string
      targetPort?: number
    }[]
  }) => req<{ ok: boolean }>('/api/tunnels', { method: 'POST', body: JSON.stringify(payload) }),
  removeTunnel: (alias: string) =>
    req<{ ok: boolean }>(`/api/tunnels/${encodeURIComponent(alias)}`, { method: 'DELETE' }),
  addHost: (payload: {
    alias: string
    hostName: string
    user?: string
    port?: number
    identityFile?: string
    proxyJump?: string
    proxyCommand?: string
  }) => req<{ ok: boolean }>('/api/hosts', { method: 'POST', body: JSON.stringify(payload) }),
  removeHost: (alias: string) =>
    req<{ ok: boolean }>(`/api/hosts/${encodeURIComponent(alias)}`, { method: 'DELETE' }),
  updateHost: (alias: string, payload: {
    hostName: string
    user?: string
    port?: number | ''
    identityFile?: string
    proxyJump?: string
    proxyCommand?: string
  }) =>
    req<{ ok: boolean }>(`/api/hosts/${encodeURIComponent(alias)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  updateTunnel: (alias: string, payload: {
    hostName: string
    user?: string
    port?: number | ''
    identityFile?: string
    proxyJump?: string
    forwards: {
      type: 'local' | 'remote' | 'dynamic'
      bind?: string
      listenPort: number
      targetHost?: string
      targetPort?: number
    }[]
  }) =>
    req<{ ok: boolean }>(`/api/tunnels/${encodeURIComponent(alias)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
}
