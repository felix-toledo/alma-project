import { useEffect, useState } from 'react'
import { CLAUDE_MODELS, isChatModel, PROVIDER_NAMES } from '../../../shared/defaults'
import type { AgentProfile, ModelChoice, ProviderId, PublicSettings } from '../../../shared/types'
import { useT } from '../i18n/useT'
import { request } from '../lib/coordinator'

const ORDER: ProviderId[] = ['meta', 'anthropic', 'xai', 'deepseek', 'vercel']
const listed = new Map<ProviderId, Promise<string[]>>()

/** Model ids of a provider, asked once per session (Claude's are built in). */
function modelsOf(provider: ProviderId): Promise<string[]> {
  if (provider === 'anthropic') return Promise.resolve(CLAUDE_MODELS)
  let ids = listed.get(provider)
  if (!ids) {
    ids = request<string[]>({ method: 'models.list', provider }).then((all) => all.filter(isChatModel), () => {
      listed.delete(provider) // try again next time (offline, bad key)
      return []
    })
    listed.set(provider, ids)
  }
  return ids
}

const keyOf = (c: ModelChoice): string => `${c.provider}|${c.model}`

/** "Who answers": the model of this conversation, over the agent's own. */
export function ModelPicker({ settings, agent, value, disabled, onChange }: { settings: PublicSettings; agent?: AgentProfile; value?: ModelChoice; disabled: boolean; onChange(choice: ModelChoice | null): void }): React.JSX.Element {
  const t = useT()
  const [models, setModels] = useState<Partial<Record<ProviderId, string[]>>>({})
  useEffect(() => {
    for (const provider of ORDER) {
      const { hasKey, fromEnv } = settings.providers[provider]
      if (hasKey || fromEnv) void modelsOf(provider).then((ids) => setModels((m) => ({ ...m, [provider]: ids })))
    }
  }, [settings.providers])

  const groups = ORDER.map((provider) => {
    const ids = new Set(models[provider] ?? [])
    if (value?.provider === provider && value.model) ids.add(value.model)
    return { provider, ids: [...ids] }
  }).filter((g) => g.ids.length)

  return (
    <label className="control">
      <span>{t('model.label')}</span>
      <select
        value={value ? keyOf(value) : ''}
        disabled={disabled}
        onChange={(e) => {
          const [provider, ...rest] = e.target.value.split('|')
          onChange(e.target.value ? { provider: provider as ProviderId, model: rest.join('|') } : null)
        }}
      >
        <option value="">{agent ? t('model.agentDefault', { name: agent.name, provider: PROVIDER_NAMES[agent.provider], model: agent.model || t('model.auto') }) : t('model.noAgent')}</option>
        {groups.map((g) => (
          <optgroup key={g.provider} label={PROVIDER_NAMES[g.provider]}>
            {g.ids.map((id) => (
              <option key={id} value={keyOf({ provider: g.provider, model: id })}>
                {id}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  )
}
