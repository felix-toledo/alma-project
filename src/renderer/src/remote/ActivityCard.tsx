// The remote-activity list (T38): newest first, device names resolved by T27.
import { activityRowText } from '../../../shared/remote/view'
import type { ActivityEntry } from '../../../shared/types'
import { useLanguage, useT } from '../i18n/useT'

export function ActivityCard({ activity }: { activity: ActivityEntry[] }): React.JSX.Element {
  const t = useT()
  const language = useLanguage()

  return (
    <div className="card">
      <h3>{t('remote.activity.title')}</h3>
      {activity.length === 0 && <p className="muted small">{t('remote.activity.none')}</p>}
      <ul className="muted small remote-activity">
        {activity.map((row, index) => {
          const text = activityRowText(row, language)
          const parts = [text.when, text.who, row.action].filter((part): part is string => !!part)
          return (
            // The audit has no stable row id; the list only grows at the front.
            <li key={`${row.ts}-${index}`}>
              {parts.join(' · ')}
              {row.outcome !== 'ok' && ` (${row.outcome})`}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
