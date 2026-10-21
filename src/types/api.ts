export interface ForwardRule {
  type: 'local' | 'remote' | 'dynamic'
  bind?: string
  localPort?: number
  remoteListenPort?: number
  remoteHost?: string
  remotePort?: number
}

export interface HostEntry {
  alias: string | null
  patterns: string[]
  wildcard: boolean
  hostName: string | null
  user: string | null
  port: string | null
  identityFile: string | null
  proxyJump: string | null
  proxyCommand: string | null
  forwards: ForwardRule[]
  isTunnel: boolean
  connectable: boolean
  source: string
  managed: boolean
}

export type TunnelState = 'running' | 'external' | 'stopped' | 'error'

export interface TunnelStatus {
  alias: string
  status: TunnelState
  processes: { pid: number; args: string; managed: boolean }[]
  ports: { port: number; ok: boolean }[]
  activeForwardIds: number[]
  managedPid: number | null
  lastError: string | null
  checkedAt: number
}

export interface TunnelEntry extends HostEntry {
  state: TunnelStatus
}

export interface ApiInfo {
  platform: string
  configPath: string
}
