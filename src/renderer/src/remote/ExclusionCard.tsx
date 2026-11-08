// Folders of the vault the phones may not read (spec 028 AC-1.8, AC-1.11). Excluding applies at once; un-excluding
// goes through settings:update, so main's native confirmation fires as for every other widening.
import { useEffect, useState } from 'react'
import { excludesWholeVault, exclusionRows, toggleExclusion } from '../../../shared/vault/paths'
import type { PublicSettings, VaultEntry } from '../../../shared/types'
import { useT } from '../i18n/useT'
import { request } from '../lib/coordinator'

interface Props {
  settings: PublicSettings
  patch(next: Partial<PublicSettings['remote']>): Promise<void>
}

export function ExclusionCard({ settings, patch }: Props): React.JSX.Element {
  const t = useT()
  const excluded = settings.remote.vaultExcluded
  // null = not loaded yet or unreadable (no vault open): then nothing can be called stale, so no rows are built.
  const [entries, setEntries] = useState<VaultEntry[] | null>(null)
  // A settings push hands a new array each time; the content is what decides a reload.
  const excludedKey = excluded.join('\n')

  // Reloaded when the vault or the list changes (a rename in Alma rewrites the list); opening the tab reads the disk again.
  useEffect(() => {
    let alive = true
    void request<VaultEntry[]>({ method: 'vault.tree' })
      .then((tree) => alive && setEntries(tree))
      .catch(() => alive && setEntries(null))
    return () => {
      alive = false
    }
  }, [settings.activeVault, excludedKey])

  const rows = entries === null ? [] : exclusionRows(excluded, entries)

  return (
    <div className="card">
      <h3>{t('remote.vault.exclude')}</h3>
      {excludesWholeVault(excluded) && <p className="text-warn small">{t('remote.vault.exclude.root')}</p>}
      {entries !== null && rows.length === 0 && <p className="muted small">{t('remote.vault.exclude.none')}</p>}
      {rows.map((row) => (
        <div key={row.path}>
          <label className="row">
            <input
              type="checkbox"
              checked={row.entry !== null || row.inherited}
              disabled={row.inherited}
              onChange={(e) => void patch({ vaultExcluded: toggleExclusion(excluded, row.path, e.target.checked) })}
            />{' '}
            {row.path}
            {row.inherited && <span className="muted small"> {t('remote.vault.exclude.inherited')}</span>}
          </label>
          {row.stale && <p className="text-warn small remote-sub">{t('remote.vault.exclude.stale', { folder: row.path })}</p>}
        </div>
      ))}
    </div>
  )
}
