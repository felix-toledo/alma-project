import type { ReadFailure } from './attach/rules'
import type { CoordinatorMessage, InstagramStatus, PublicSettings, RequestEnvelope, SecretProviderId } from './types'

/** What `attach.inspect` says about a path the page holds (spec 030 AC-1.9). */
export type PathInfo =
  | { kind: 'file'; name: string; size: number }
  | { kind: 'folder'; name: string; files: { path: string; name: string; size: number }[]; skipped: number }
  | { kind: 'failed'; reason: ReadFailure }

/** What `attach.read` answers: the bytes of a granted path, or why not (spec 030 AC-2.4). */
export type PathRead = { ok: true; name: string; size: number; base64: string } | { ok: false; reason: ReadFailure | 'too-big' }

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
  remote: {
    /** After a successful rename or move in the vault view: the folder's remote exclusions follow it (no dialog). */
    moveExclusions(from: string, to: string): Promise<void>
  }
  /** Files for the chat composer (spec 030). The page never reads the disk: main answers only for paths it granted. */
  attach: {
    /** Preload only: the disk path of a dropped or pasted `File` ('' when it has none, like a pasted screenshot). Grants it once. */
    pathOf(file: File): string
    /** Native dialog, several files, no type filter. Grants the returned paths; cancelling returns `[]`. */
    pick(): Promise<string[]>
    /** A granted path: its size, or for a folder its direct regular files (granted) and how many entries were skipped. */
    inspect(path: string): Promise<PathInfo>
    /** The bytes of a granted path (size checked before reading); the grant is used up. */
    read(path: string): Promise<PathRead>
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
