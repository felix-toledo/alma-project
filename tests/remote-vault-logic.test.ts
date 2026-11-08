import { describe, expect, it } from 'vitest'
import type { VaultEntry } from '../src/shared/types'
import { isCompanyThread, listableThreads } from '../src/shared/threads'
import { baseName, excludesWholeVault, exclusionRows, findByName, toggleExclusion, fuzzyScore, IMAGE_EXT, isExcluded, isReachable, join, listFolder, moveExclusions, resolveRelative, resolveVaultAsset, staleExclusions, noteName, parentOf } from '../src/shared/vault/paths'

describe('fuzzy name rule (spec 028 T11, moved from the renderer)', () => {
  it('AC-2.10 (028) fuzzyScore is 0 unless every character appears in order, 1 for empty, runs and word starts score higher', () => {
    expect(fuzzyScore('', 'Notes/a.md')).toBe(1)
    expect(fuzzyScore('  ', 'Notes/a.md')).toBe(1)
    expect(fuzzyScore('abc', 'cba')).toBe(0)
    expect(fuzzyScore('xyz', 'Notes/a.md')).toBe(0)
    expect(fuzzyScore('NOTES', 'notes/a.md')).toBeGreaterThan(0)
    expect(fuzzyScore('n a', 'notes/a.md')).toBe(fuzzyScore('na', 'notes/a.md'))
    expect(fuzzyScore('abc', 'abcxxx')).toBeGreaterThan(fuzzyScore('abc', 'axbxcx'))
    expect(fuzzyScore('b', 'a-b')).toBeGreaterThan(fuzzyScore('b', 'aab'))
    expect(fuzzyScore('a', 'dir/a')).toBeGreaterThan(fuzzyScore('a', 'adir/x'))
    expect(fuzzyScore('abc', 'abc')).toBeCloseTo(26.85, 5)
  })

  it('AC-2.10 (028) path helpers behave as the vault view always had them', () => {
    expect(baseName('a/b/c.md')).toBe('c.md')
    expect(baseName('c.md')).toBe('c.md')
    expect(parentOf('a/b/c.md')).toBe('a/b')
    expect(parentOf('c.md')).toBe('')
    expect(join('a', '', 'b')).toBe('a/b')
    expect(noteName('a/Idea.MD')).toBe('Idea')
    expect(noteName('a/draw.excalidraw')).toBe('draw')
    expect(noteName('a/pic.png')).toBe('pic.png')
    expect(IMAGE_EXT.test('x/Photo.JPEG')).toBe(true)
    expect(IMAGE_EXT.test('x/notes.md')).toBe(false)
  })
})

describe('which threads are listable (spec 028 T9)', () => {
  const agents = [{ id: 'general' }, { id: 'ceo', companyId: 'acme' }, { id: 'dev', companyId: 'acme' }]
  const rows = [
    { id: 't1', agentId: 'general' },
    { id: 't2', agentId: 'ceo' },
    { id: 't3', agentId: 'gone-agent' },
    { id: 't4', agentId: 'dev' },
    { id: 't5', agentId: 'general' }
  ]

  it('AC-3.1 (028) company-agent threads are not listable, order untouched', () => {
    expect(listableThreads(rows, agents).map((r) => r.id)).toEqual(['t1', 't3', 't5'])
    expect(isCompanyThread('ceo', agents)).toBe(true)
    expect(isCompanyThread('general', agents)).toBe(false)
    expect(rows).toHaveLength(5)
  })

  it('AC-3.1 (028) a thread of a deleted agent is listed like the PC lists it', () => {
    expect(isCompanyThread('gone-agent', agents)).toBe(false)
    expect(listableThreads([{ id: 'x', agentId: 'gone-agent' }], [])).toEqual([{ id: 'x', agentId: 'gone-agent' }])
  })
})

describe('what the phone may reach (spec 028 T12)', () => {
  const excluded = ['Private', 'Work/Taxes/']

  it('AC-1.9 (028) exclusion is case-insensitive and covers every folder under it', () => {
    expect(isExcluded('Private', excluded)).toBe(true)
    expect(isExcluded('PRIVATE/diary.md', excluded)).toBe(true)
    expect(isExcluded('private/a/b/c.md', excluded)).toBe(true)
    expect(isExcluded('work/taxes/2024.md', excluded)).toBe(true)
    expect(isExcluded('Private\\diary.md', excluded)).toBe(true)
    expect(isExcluded('Private/', excluded)).toBe(true)
    expect(isExcluded('Privately/a.md', excluded)).toBe(false)
    expect(isExcluded('Work/a.md', excluded)).toBe(false)
    expect(isExcluded('Work', excluded)).toBe(false)
    expect(isExcluded('Private/a.md', ['private\\'])).toBe(true)
    expect(isExcluded('Private/a.md', [])).toBe(false)
    expect(isExcluded('a.md', ['', '  '])).toBe(false)
    expect(excludesWholeVault(['', '  ', 'Private'])).toBe(false)
  })

  it('AC-1.8 (028) an entry that canonicalizes to the vault root excludes everything (Q12)', () => {
    for (const root of ['/', '.', '\\', 'Private/..', './']) {
      expect(excludesWholeVault([root])).toBe(true)
      expect(isExcluded('a.md', [root])).toBe(true)
      expect(isExcluded('Work/Taxes/b.md', ['Private', root])).toBe(true)
      expect(isReachable('', [root])).toBe(false)
      expect(isReachable('a.md', [root])).toBe(false)
    }
  })

  it('AC-1.9 (028) a path that goes .. back into an excluded folder is excluded', () => {
    expect(isExcluded('Public/../Private/diary.md', excluded)).toBe(true)
    expect(isExcluded('./Private/./diary.md', excluded)).toBe(true)
    expect(isExcluded('a/b/../../private/x.md', excluded)).toBe(true)
    expect(isExcluded('Private/../Public/x.md', excluded)).toBe(false)
  })

  it('AC-2.4 (028) dot segment, node_modules, .. , absolute and drive paths are unreachable', () => {
    const blocked = [
      '.git/config', 'a/.obsidian/x.md', '.hidden.md', 'a/./b.md', '../x.md', 'a/../x.md', 'a\\..\\x.md',
      'node_modules/x/readme.md', 'a/Node_Modules/x.md', '/etc/passwd', '\\\\server\\share\\x.md', 'C:/x.md', 'c:\\x.md', 'C:x.md',
      'Private/a.md', 'PRIVATE/a.md', 'a/Private./b.md', 'a/b. /c.md', 'a/b.md:stream', 'a\u0000b.md'
    ]
    for (const path of blocked) expect(isReachable(path, excluded), path).toBe(false)
    const open = ['', 'a.md', 'Alma/Memory.md', 'Work/plan.md', 'Work/Taxes2/a.md', 'notes.d/a.md', 'Privately\\a.md', 'a/b/']
    for (const path of open) expect(isReachable(path, excluded), path).toBe(true)
  })
})

const file = (path: string, size = 1, mtime = 10): VaultEntry => ({ path, kind: 'file', size, mtime })
const folder = (path: string): VaultEntry => ({ path, kind: 'folder', size: 0, mtime: 5 })

describe('listing one folder (spec 028 T13)', () => {
  const entries = [
    folder('Work'), folder('Alma'), folder('Private'), folder('.git'), folder('node_modules'), folder('Work/Sub'),
    file('b.md', 20, 100), file('a.md', 10, 200), file('Work/plan.md'), file('Work/Sub/deep.md'), file('Private/diary.md'),
    file('.hidden.md'), file('Alma/Memory.md'), file('Work/.secret.md'), folder('Work/Private')
  ]
  const names = (folderPath: string, excluded: string[] = [], language: 'es' | 'en' = 'en') => listFolder(entries, folderPath, excluded, language).map((e) => e.name)

  it('AC-2.1 (028) lists one folder only', () => {
    expect(names('')).toEqual(['Alma', 'Private', 'Work', 'a.md', 'b.md'])
    expect(names('Work')).toEqual(['Private', 'Sub', 'plan.md'])
    expect(names('Work/')).toEqual(['Private', 'Sub', 'plan.md'])
    expect(names('Work\\Sub')).toEqual(['deep.md'])
    expect(listFolder(entries, '', [], 'en').find((e) => e.name === 'b.md')).toEqual({ name: 'b.md', kind: 'file', size: 20, mtime: 100 })
    expect(names('Nope')).toEqual([])
  })

  it('AC-2.1 (028) folders before files, ñ after n in es', () => {
    const list = [file('oso.md'), file('ñandú.md'), file('nube.md'), folder('zeta'), folder('Álbum'), folder('alfa')]
    expect(listFolder(list, '', [], 'es').map((e) => e.name)).toEqual(['Álbum', 'alfa', 'zeta', 'nube.md', 'ñandú.md', 'oso.md'])
    expect(listFolder(list, '', [], 'en').map((e) => e.name)).toEqual(['Álbum', 'alfa', 'zeta', 'ñandú.md', 'nube.md', 'oso.md'])
  })

  it('AC-2.1 (028) hides excluded and dot entries', () => {
    expect(names('', ['private'])).toEqual(['Alma', 'Work', 'a.md', 'b.md'])
    expect(names('Work', ['PRIVATE'])).toEqual(['Private', 'Sub', 'plan.md'])
    expect(names('Work', ['work/private'])).toEqual(['Sub', 'plan.md'])
    expect(names('Private', ['Private'])).toEqual([])
    expect(names('.git')).toEqual([])
    expect(names('node_modules')).toEqual([])
  })
})

describe('finding files by name (spec 028 T14)', () => {
  const pool = [
    file('Ideas/Budget plan.md'), file('Budget.md'), file('Work/budget-2024.md'), file('Private/budget.md'), file('.git/budget.md'),
    file('node_modules/budget.md'), folder('Budgets'), file('Notes/unrelated.md'), file('Work/Taxes/budget.md')
  ]

  it('AC-2.10 (028) 51 matches yield 50', () => {
    const many = Array.from({ length: 51 }, (_, i) => file(`Log/day-${i}.md`))
    expect(findByName(many, 'day', [])).toHaveLength(50)
    expect(findByName(many, 'day', [], 3)).toHaveLength(3)
    expect(findByName(many, 'day', []).every((hit) => hit.path.startsWith('Log/day-'))).toBe(true)
  })

  it('AC-2.10 (028) empty query lists nothing', () => {
    expect(findByName(pool, '', [])).toEqual([])
    expect(findByName(pool, '   ', [])).toEqual([])
  })

  it('AC-2.10 (028) never returns hidden or excluded', () => {
    const paths = findByName(pool, 'budget', ['private', 'Work/Taxes']).map((hit) => hit.path)
    expect(paths).toEqual(expect.arrayContaining(['Budget.md', 'Ideas/Budget plan.md', 'Work/budget-2024.md']))
    expect(paths).toHaveLength(3)
  })

  it('AC-2.10 (028) matches the name, never content', () => {
    // the only input is the entry list: a word that is in no path matches nothing
    expect(findByName(pool, 'unrelatedcontentword', [])).toEqual([])
    expect(findByName(pool, 'unrel', [])).toEqual([{ path: 'Notes/unrelated.md', name: 'unrelated.md' }])
    expect(findByName(pool, 'budget', []).some((hit) => hit.path === 'Budgets')).toBe(false)
    expect(findByName(pool, 'md', []).length).toBe(0)
    expect(findByName([file('a/budget.md')], 'BUDGET', [])).toHaveLength(1)
  })

  it('AC-2.10 (028) better matches come first', () => {
    const hits = findByName([file('Archive/x/zz-budget.md'), file('budget.md')], 'budget', [])
    expect(hits.map((hit) => hit.path)).toEqual(['budget.md', 'Archive/x/zz-budget.md'])
  })
})

describe('resolving an embedded image (spec 028 T15)', () => {
  const pool = [
    file('Notes/a.md'), file('Notes/img/pic.png'), file('Attachments/Logo.PNG'), file('top.png'), file('Private/secret.png'),
    file('.obsidian/hidden.png'), file('Work/Taxes/scan.png'), folder('Notes/img')
  ]

  it('AC-2.11 (028) relative, exact and by-file-name resolution', () => {
    expect(resolveVaultAsset('img/pic.png', 'Notes/a.md', pool)).toBe('Notes/img/pic.png')
    expect(resolveVaultAsset('../top.png', 'Notes/a.md', pool)).toBe('top.png')
    expect(resolveVaultAsset('Attachments/Logo.PNG', 'Notes/a.md', pool)).toBe('Attachments/Logo.PNG')
    expect(resolveVaultAsset('logo.png', 'Notes/a.md', pool)).toBe('Attachments/Logo.PNG')
    expect(resolveVaultAsset('top.png', 'a.md', pool)).toBe('top.png')
    expect(resolveVaultAsset('missing.png', 'Notes/a.md', pool)).toBeNull()
    expect(resolveVaultAsset('img', 'Notes/a.md', pool)).toBeNull()
    expect(resolveVaultAsset('https://example.com/pic.png', 'Notes/a.md', pool)).toBeNull()
  })

  it('AC-1.9 (028) an excluded or hidden target resolves to null', () => {
    const excluded = ['private', 'Work/Taxes']
    expect(resolveVaultAsset('secret.png', 'Notes/a.md', pool, excluded)).toBeNull()
    expect(resolveVaultAsset('../Private/secret.png', 'Notes/a.md', pool, excluded)).toBeNull()
    expect(resolveVaultAsset('Private/secret.png', 'Notes/a.md', pool, excluded)).toBeNull()
    expect(resolveVaultAsset('scan.png', 'Notes/a.md', pool, excluded)).toBeNull()
    expect(resolveVaultAsset('hidden.png', 'Notes/a.md', pool, excluded)).toBeNull()
    expect(resolveVaultAsset('../.obsidian/hidden.png', 'Notes/a.md', pool, excluded)).toBeNull()
    expect(resolveVaultAsset('img/pic.png', 'Notes/a.md', pool, excluded)).toBe('Notes/img/pic.png')
  })
})

describe('a path written in a note (spec 028 T50)', () => {
  it('AC-2.15 (028) resolveRelative resolves against the note folder and says when it climbs out of the vault', () => {
    expect(resolveRelative('b.md', 'Docs/a.md')).toEqual({ path: 'Docs/b.md', escapes: false })
    expect(resolveRelative('../b.md', 'Docs/a.md')).toEqual({ path: 'b.md', escapes: false })
    expect(resolveRelative('./sub/../c.md', 'Docs/a.md')).toEqual({ path: 'Docs/c.md', escapes: false })
    expect(resolveRelative('b.md', 'a.md')).toEqual({ path: 'b.md', escapes: false })
    expect(resolveRelative('../../b.md', 'Docs/a.md')).toEqual({ path: 'b.md', escapes: true })
    // Case is kept: the phone asks for the spelling the note wrote.
    expect(resolveRelative('Sub/Ñandú.md', 'Docs/a.md').path).toBe('Docs/Sub/Ñandú.md')
  })
})

describe('exclusions follow their folder (spec 028 T16)', () => {
  it('AC-1.11 (028) an exclusion moves with its folder', () => {
    expect(moveExclusions(['Private', 'Work'], 'private', 'Archive/Private')).toEqual(['Archive/Private', 'Work'])
    expect(moveExclusions(['Private', 'Work'], 'Private/', 'Personal')).toEqual(['Personal', 'Work'])
    expect(moveExclusions(['Work\\Taxes'], 'Work/Taxes', 'Work/Fiscal')).toEqual(['Work/Fiscal'])
  })

  it('AC-1.11 (028) descendant exclusions are rewritten', () => {
    expect(moveExclusions(['Work/Taxes/2024', 'Work/Taxes', 'Workshop', 'Other'], 'work', 'Job')).toEqual(['Job/Taxes/2024', 'Job/Taxes', 'Workshop', 'Other'])
    expect(moveExclusions(['A/b/C'], 'a/B', 'Z')).toEqual(['Z/C'])
    expect(moveExclusions(['Private'], 'Private', 'Private')).toEqual(['Private'])
  })

  it('AC-1.11 (028) a move naming a path that is not in the list changes nothing', () => {
    const list = ['Private', 'Work/Taxes']
    expect(moveExclusions(list, 'Public', 'Elsewhere')).toEqual(list)
    expect(moveExclusions(list, 'Work', 'Job')).toEqual(['Private', 'Job/Taxes'])
    expect(moveExclusions(list, '', 'Root')).toEqual(list)
    expect(list).toEqual(['Private', 'Work/Taxes'])
  })

  it('AC-1.8 AC-1.11 (028) the exclusion editor rows: every folder, then stale and root entries', () => {
    const tree = [folder('Work'), folder('Work/Taxes'), folder('Work/Taxes/2024'), folder('Private'), file('Private/a.md')]
    const rows = exclusionRows(['work/taxes', 'Gone'], tree)
    expect(rows).toEqual([
      { path: 'Private', entry: null, inherited: false, stale: false, root: false },
      { path: 'Work', entry: null, inherited: false, stale: false, root: false },
      { path: 'Work/Taxes', entry: 'work/taxes', inherited: false, stale: false, root: false },
      { path: 'Work/Taxes/2024', entry: null, inherited: true, stale: false, root: false },
      { path: 'Gone', entry: 'Gone', inherited: false, stale: true, root: false }
    ])
    const withRoot = exclusionRows(['/'], tree)
    expect(withRoot.at(-1)).toEqual({ path: '/', entry: '/', inherited: false, stale: false, root: true })
    expect(withRoot.filter((row) => !row.root).every((row) => row.inherited)).toBe(true)
    expect(exclusionRows([], [])).toEqual([])
  })

  it('AC-1.8 AC-1.10 (028) turning a row on adds the folder once, turning it off removes every spelling of it', () => {
    expect(toggleExclusion(['Private'], 'Work/Taxes', true)).toEqual(['Private', 'Work/Taxes'])
    expect(toggleExclusion(['work/taxes'], 'Work/Taxes', true)).toEqual(['work/taxes'])
    expect(toggleExclusion(['Private', 'work/taxes/', 'Work\\Taxes'], 'Work/Taxes', false)).toEqual(['Private'])
    expect(toggleExclusion(['Private', '/', '.'], '/', false)).toEqual(['Private'])
    expect(toggleExclusion(['Gone'], 'Gone', false)).toEqual([])
  })

  it('AC-1.11 (028) a path that no longer exists is stale and its new location is not excluded', () => {
    const tree = [folder('Work'), folder('Work/Taxes'), file('Work/a.md'), folder('Moved'), file('Private')]
    expect(staleExclusions(['work/taxes', 'Private', 'Gone', 'Work/Gone/Deep'], tree)).toEqual(['Private', 'Gone', 'Work/Gone/Deep'])
    expect(staleExclusions([], tree)).toEqual([])
    expect(staleExclusions(['Work\\Taxes/'], tree)).toEqual([])
    // the root is always there: an entry for it is not stale (it excludes everything)
    expect(staleExclusions(['/', '.', 'Gone'], tree)).toEqual(['Gone'])
    // renamed outside Alma: the old name is stale, the new folder is reachable until the person excludes it
    expect(isExcluded('Moved/x.md', ['Private'])).toBe(false)
  })
})
