import { useEffect, useState } from 'react'
import { Cable, MonitorSmartphone, TerminalSquare } from 'lucide-react'
import { api } from '@/lib/api'
import type { ApiInfo } from '@/types/api'
import ConnectionsSection from '@/sections/ConnectionsSection'
import TunnelsSection from '@/sections/TunnelsSection'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Toaster } from '@/components/ui/sonner'

const PLATFORM_LABEL: Record<string, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
}

export default function Home() {
  const [info, setInfo] = useState<ApiInfo | null>(null)

  useEffect(() => {
    api.info().then(setInfo).catch(() => setInfo(null))
  }, [])

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto max-w-6xl px-6 py-4 flex items-center gap-3">
          <TerminalSquare className="h-6 w-6" />
          <h1 className="text-lg font-semibold">SSH Manager</h1>
          {info && (
            <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
              <MonitorSmartphone className="h-3.5 w-3.5" />
              {PLATFORM_LABEL[info.platform] ?? info.platform}
              <span className="font-mono">{info.configPath}</span>
            </span>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-6">
        <Tabs defaultValue="tunnels">
          <TabsList>
            <TabsTrigger value="tunnels" className="gap-1.5">
              <Cable className="h-4 w-4" /> 隧道
            </TabsTrigger>
            <TabsTrigger value="connections" className="gap-1.5">
              <TerminalSquare className="h-4 w-4" /> 连接
            </TabsTrigger>
          </TabsList>
          <TabsContent value="tunnels" className="mt-5">
            <TunnelsSection />
          </TabsContent>
          <TabsContent value="connections" className="mt-5">
            <ConnectionsSection />
          </TabsContent>
        </Tabs>
      </main>

      <Toaster richColors position="top-right" />
    </div>
  )
}
