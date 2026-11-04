// Modes (scenes) and rules: the ones Home Assistant runs by itself, the ones where Alma wakes up to look and decide,
// and the camera watches that are running right now.
import { Eye, Play, Trash2, Zap } from 'lucide-react'
import type { HomeScene } from '../../../shared/home'
import type { HomeRulesView } from '../../../shared/types'
import { formatDateTime } from '../../../shared/i18n/format'
import { useLanguage, useT } from '../i18n/useT'
import { request } from '../lib/coordinator'
import { Icon } from '../umbra/Icon'
import { control } from './homeLib'

interface Props {
  rules: HomeRulesView
  scenes: HomeScene[]
}

function Toggle({ on, label, onChange }: { on: boolean; label: string; onChange(on: boolean): void }): React.JSX.Element {
  return (
    <button role="switch" aria-checked={on} aria-label={label} className={`home-switch${on ? ' on' : ''}`} onClick={() => onChange(!on)}>
      <span />
    </button>
  )
}

export function RulesPanel({ rules, scenes }: Props): React.JSX.Element {
  const t = useT()
  const language = useLanguage()
  const del = (kind: 'ha' | 'judgment' | 'watch', id: string, name: string): void => {
    if (confirm(t('home.rule.deleteConfirm', { name }))) void request({ method: 'home.rule.delete', kind, id })
  }
  return (
    <div className="home-rules">
      <section className="card">
        <h3>
          <Icon icon={Play} size={16} /> {t('home.modes')}
        </h3>
        {scenes.length === 0 ? (
          <p className="muted small">{t('home.modes.none')}</p>
        ) : (
          <div className="row">
            {scenes.map((scene) => (
              <button key={scene.entityId} onClick={() => void control(scene.entityId, 'scene/turn_on')}>
                {scene.name}
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <h3>
          <Icon icon={Zap} size={16} /> {t('home.rules.auto')}
        </h3>
        <p className="muted small">{t('home.rules.autoHint')}</p>
        {rules.automations.length === 0 && <p className="muted small">{t('home.rules.autoNone')}</p>}
        {rules.automations.map((rule) => (
          <div key={rule.id} className="home-rule">
            <Toggle on={rule.enabled} label={t('home.rule.enable', { name: rule.name })} onChange={(enabled) => void request({ method: 'home.rule.toggle', kind: 'ha', id: rule.id, enabled })} />
            <div className="grow">
              <b>{rule.name}</b>
              <div className="muted small">{rule.lastTriggered ? t('home.rule.lastTriggered', { when: formatDateTime(language, new Date(rule.lastTriggered), 'short') }) : t('home.rule.never')}</div>
            </div>
            <button className="icon-button" title={t('common.delete')} onClick={() => del('ha', rule.id, rule.name)}>
              <Icon icon={Trash2} size="sm" />
            </button>
          </div>
        ))}
      </section>

      <section className="card">
        <h3>
          <Icon icon={Eye} size={16} /> {t('home.rules.judgment')}
        </h3>
        <p className="muted small">{t('home.rules.judgmentHint')}</p>
        {rules.judgment.length === 0 && <p className="muted small">{t('home.rules.judgmentNone')}</p>}
        {rules.judgment.map((rule) => (
          <div key={rule.id} className="home-rule">
            <Toggle on={rule.enabled} label={t('home.rule.enable', { name: rule.name })} onChange={(enabled) => void request({ method: 'home.rule.toggle', kind: 'judgment', id: rule.id, enabled })} />
            <div className="grow">
              <b>{rule.name}</b>
              <div className="muted small">
                {rule.entityId}
                {rule.to ? ` → ${rule.to}` : ''}
                {rule.between ? ` · ${t('home.rule.between', { from: rule.between[0], to: rule.between[1] })}` : ''} · {t('home.rule.cooldown', { minutes: rule.cooldownMin })} · {rule.createdBy === 'agent' ? t('home.rule.byAgent') : t('home.rule.byUser')}
              </div>
              <div className="small">{rule.prompt}</div>
            </div>
            <button className="icon-button" title={t('common.delete')} onClick={() => del('judgment', rule.id, rule.name)}>
              <Icon icon={Trash2} size="sm" />
            </button>
          </div>
        ))}
      </section>

      {rules.watches.length > 0 && (
        <section className="card">
          <h3>
            <Icon icon={Eye} size={16} /> {t('home.watches')}
          </h3>
          {rules.watches.map((watch) => (
            <div key={watch.id} className="home-rule">
              <div className="grow">
                <b>{watch.cameraName}</b> — {watch.condition}
                <div className="muted small">
                  {t('home.watch.line', { every: watch.everySec, checks: watch.checks, until: formatDateTime(language, watch.until, 'time') })}
                  {watch.lastNote ? ` · ${t('home.watch.last', { note: watch.lastNote })}` : ''}
                </div>
              </div>
              <button className="ghost small" onClick={() => void request({ method: 'home.rule.delete', kind: 'watch', id: watch.id })}>
                {t('chat.stop')}
              </button>
            </div>
          ))}
        </section>
      )}
    </div>
  )
}
