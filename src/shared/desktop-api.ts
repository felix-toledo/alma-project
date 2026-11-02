import type { CoordinatorMessage, InstagramStatus, PublicSettings, RequestEnvelope, SecretProviderId } from './types'

/** The API the preload exposes to the renderer as `window.desktop`. */
export interface DesktopApi {
  platform: string
  coordinator: {
    send(message: RequestEnvelope): void
    /** 80 ms of mono 16 kHz Int16 microphone audio for the voice assistant. */
    sendAudio(pcm: ArrayBuffer): void
    onMessage(listener: (message: CoordinatorMessage) => void): () => void
    onConnected(listener: () => void): () => void
  }
  settings: {
    get(): Promise<PublicSettings>
    update(patch: Partial<PublicSettings>): Promise<PublicSettings>
    setApiKey(provider: SecretProviderId, apiKey: string): Promise<PublicSettings>
    setCompanySecret(companyId: string, secret: string): Promise<PublicSettings>
    onChanged(listener: () => void): () => void
  }
  instagram: {
    status(): Promise<InstagramStatus>
    /** Opens Instagram's login page in the app's browser; resolves when that window closes. */
    connect(): Promise<InstagramStatus>
    disconnect(): Promise<InstagramStatus>
  }
  /** A notification was clicked: show this thread. */
  onOpenThread(listener: (threadId: string) => void): () => void
  /** A reminder fired: shown inside the app too, since OS toasts can be dropped. */
  onReminder(listener: (reminder: { title: string; body: string }) => void): () => void
  pickFolder(): Promise<string | null>
  openPath(path: string): Promise<string>
  /** Documents\Alma\Vault: where a new vault goes by default. */
  defaultVaultPath(): Promise<string>
}
