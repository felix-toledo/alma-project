import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { DesktopApi, PathInfo, PathRead } from '../shared/desktop-api'
import type { AudioEnvelope, CoordinatorMessage, InstagramStatus, PublicSettings, RequestEnvelope, SecretProviderId } from '../shared/types'

// MessagePorts can't cross the context bridge, so the preload keeps the port and relays messages.
let port: MessagePort | null = null
const queue: RequestEnvelope[] = []
const listeners = new Set<(message: CoordinatorMessage) => void>()
const connectionListeners = new Set<() => void>()

ipcRenderer.on('coordinator:port', (event) => {
  port?.close()
  port = event.ports[0]
  port.onmessage = (e) => {
    for (const listener of listeners) listener(e.data as CoordinatorMessage)
  }
  port.start()
  for (const message of queue.splice(0)) port.postMessage(message)
  for (const listener of connectionListeners) listener()
})

// The window's first show can come before React listens (the greeting landing at start, spec 033 BR-29): the request is kept for it.
let unopened: string | null = null
const openListeners = new Set<(threadId: string) => void>()
ipcRenderer.on('app:openThread', (_event, threadId: string) => {
  if (openListeners.size) for (const listener of openListeners) listener(threadId)
  else unopened = threadId
})

ipcRenderer.on('coordinator:restarted', () => ipcRenderer.send('coordinator:connect'))
ipcRenderer.send('coordinator:connect')

const api: DesktopApi = {
  platform: process.platform,
  coordinator: {
    send(message: RequestEnvelope): void {
      if (port) port.postMessage(message)
      else queue.push(message)
    },
    /**
     * Microphone audio: dropped (not queued) while the coordinator is reconnecting; it's live anyway.
     * Copied, not transferred: a port to a utility process silently drops messages with ArrayBuffers in the transfer list.
     */
    sendAudio(pcm: ArrayBuffer): void {
      port?.postMessage({ kind: 'audio', pcm } satisfies AudioEnvelope)
    },
    onMessage(listener: (message: CoordinatorMessage) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onConnected(listener: () => void): () => void {
      connectionListeners.add(listener)
      return () => connectionListeners.delete(listener)
    }
  },
  settings: {
    get: (): Promise<PublicSettings> => ipcRenderer.invoke('settings:get'),
    update: (patch: Partial<PublicSettings>): Promise<PublicSettings> => ipcRenderer.invoke('settings:update', patch),
    setApiKey: (provider: SecretProviderId, apiKey: string): Promise<PublicSettings> =>
      ipcRenderer.invoke('settings:setApiKey', provider, apiKey),
    setCompanySecret: (companyId: string, secret: string): Promise<PublicSettings> => ipcRenderer.invoke('settings:setCompanySecret', companyId, secret),
    onChanged(listener: () => void): () => void {
      const handler = (): void => listener()
      ipcRenderer.on('settings:changed', handler)
      return () => ipcRenderer.removeListener('settings:changed', handler)
    }
  },
  instagram: {
    status: (): Promise<InstagramStatus> => ipcRenderer.invoke('instagram:status'),
    connect: (): Promise<InstagramStatus> => ipcRenderer.invoke('instagram:connect'),
    disconnect: (): Promise<InstagramStatus> => ipcRenderer.invoke('instagram:disconnect')
  },
  remote: {
    moveExclusions: (from: string, to: string): Promise<void> => ipcRenderer.invoke('remote:moveExclusions', { from, to })
  },
  attach: {
    // Only a real File (dropped from the computer) has a path; the grant is sent before any inspect or read of it.
    pathOf(file: File): string {
      const path = webUtils.getPathForFile(file)
      if (path) ipcRenderer.send('attach:grant', path)
      return path
    },
    pick: (): Promise<string[]> => ipcRenderer.invoke('attach:pick'),
    inspect: (path: string): Promise<PathInfo> => ipcRenderer.invoke('attach:inspect', path),
    read: (path: string): Promise<PathRead> => ipcRenderer.invoke('attach:read', path)
  },
  onOpenThread(listener: (threadId: string) => void): () => void {
    openListeners.add(listener)
    if (unopened) listener(unopened)
    unopened = null
    return () => openListeners.delete(listener)
  },
  onReminder(listener: (reminder: { title: string; body: string }) => void): () => void {
    const handler = (_event: unknown, reminder: { title: string; body: string }): void => listener(reminder)
    ipcRenderer.on('app:reminder', handler)
    return () => ipcRenderer.removeListener('app:reminder', handler)
  },
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickFolder'),
  openPath: (path: string): Promise<string> => ipcRenderer.invoke('shell:openPath', path),
  defaultVaultPath: (): Promise<string> => ipcRenderer.invoke('vault:defaultPath')
}

contextBridge.exposeInMainWorld('desktop', api)
