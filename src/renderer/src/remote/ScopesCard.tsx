// What the phones may do (T38): the six scope switches, the locks, continue and send-files sub-switches,
// the allowed cameras, the excluded vault folders and the agent that answers. Every change goes through
// settings:update, so the native dialogs of T5 fire as usual.
import type { PublicSettings, RemoteScope } from '../../../shared/types'
import { useHome } from '../home/useHome'
import { useT } from '../i18n/useT'
import { ExclusionCard } from './ExclusionCard'

const SCOPES: RemoteScope[] = ['chat', 'approve', 'home', 'cameras', 'vault', 'history']

interface Props {
  settings: PublicSettings
  onChange(patch: Partial<PublicSettings>): Promise<void>
}

export function ScopesCard({ settings, onChange }: Props): React.JSX.Element {
  const t = useT()
  const config = settings.remote
  const patch = (next: Partial<typeof config>): Promise<void> => onChange({ remote: { ...config, ...next } })
  const { snapshot } = useHome(settings.home.enabled)
  const cameras = snapshot.things.filter((thing) => thing.kind === 'camera')

  const toggleCamera = (entityId: string, allow: boolean): void => {
    const next = allow ? [...config.cameras, entityId] : config.cameras.filter((id) => id !== entityId)
    void patch({ cameras: next })
  }

  return (
    <>
      <div className="card">
        {SCOPES.map((scope) => (
          <div key={scope}>
            <label className="row">
              <input
                type="checkbox"
                checked={config.scopes[scope]}
                onChange={(e) => void patch({ scopes: { ...config.scopes, [scope]: e.target.checked } })}
              />{' '}
              {t(`remote.scope.${scope}`)}
            </label>
            {scope === 'chat' && config.scopes.chat && (
              <label className="row remote-sub">
                <input type="checkbox" checked={config.sendFiles} onChange={(e) => void patch({ sendFiles: e.target.checked })} />{' '}
                {t('remote.scope.attachments')}
              </label>
            )}
            {scope === 'chat' && config.scopes.chat && <p className="muted small remote-sub">{t('remote.scope.attachments.hint')}</p>}
            {scope === 'home' && config.scopes.home && (
              <label className="row remote-sub">
                <input type="checkbox" checked={config.sensitive} onChange={(e) => void patch({ sensitive: e.target.checked })} />{' '}
                {t('remote.scope.sensitive')}
              </label>
            )}
            {scope === 'home' && config.scopes.home && <p className="muted small remote-sub">{t('remote.scope.sensitive.hint')}</p>}
            {scope === 'history' && config.scopes.history && (
              <label className="row remote-sub">
                <input type="checkbox" checked={config.continueHistory} onChange={(e) => void patch({ continueHistory: e.target.checked })} />{' '}
                {t('remote.scope.history.continue')}
              </label>
            )}
            {scope === 'history' && config.scopes.history && <p className="muted small remote-sub">{t('remote.scope.history.continue.hint')}</p>}
          </div>
        ))}
      </div>

      {config.scopes.vault && <ExclusionCard settings={settings} patch={patch} />}

      {config.scopes.cameras && (
        <div className="card">
          <h3>{t('remote.scope.cameras.allow')}</h3>
          {config.cameras.length === 0 && <p className="muted small">{t('remote.cameras.none')}</p>}
          {cameras.map((camera) => (
            <label className="row" key={camera.entityId}>
              <input
                type="checkbox"
                checked={config.cameras.includes(camera.entityId)}
                onChange={(e) => toggleCamera(camera.entityId, e.target.checked)}
              />{' '}
              {camera.name}
            </label>
          ))}
        </div>
      )}

      <div className="card">
        <h3>{t('channels.agent')}</h3>
        <select value={config.agentId} onChange={(e) => void patch({ agentId: e.target.value })}>
          {settings.agents
            .filter((a) => !a.companyId)
            .map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
        </select>
      </div>
    </>
  )
}
