import { describe, expect, it } from 'vitest'
import { AGENT_NAMES } from '../src/shared/agentNames'
import { buildCompany, COMPANY_COLORS, companyTemplates, defaultCompanyVault, memberAgent, type NewCompanyInput, newId, type PositionSpec, pickName } from '../src/shared/company'
import { canAnswerFrom, COMPANY_AUTHORING_TOOLS, companyIssues, proposalOfCreation, vaultIssues } from '../src/shared/companyAuthoring'
import { DEFAULT_META_MODEL } from '../src/shared/defaults'
import type { AgentProfile, Company } from '../src/shared/types'

const existingCompany = (id: string): Company => ({
  id,
  name: id,
  mission: '',
  goals: '',
  vault: `C:\\v\\${id}`,
  color: '#000',
  budgetUsd: 20,
  members: [],
  email: { address: '', imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 465 },
  whatsapp: false,
  createdAt: 0
})

/** The Equipos form's `create()` as it was before the builder moved to shared (TeamsSettings.tsx), kept as the reference. */
function legacyCreate(chosen: ReturnType<typeof companyTemplates>[number] | undefined, name: string, vault: string, existing: Company[]) {
  const company: Company = {
    id: newId('empresa'),
    name,
    mission: chosen?.mission ?? '',
    goals: chosen?.goals ?? '',
    vault,
    color: chosen?.color ?? COMPANY_COLORS[existing.length % COMPANY_COLORS.length],
    budgetUsd: 20,
    members: [],
    email: { address: '', imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 465 },
    whatsapp: false,
    createdAt: 0
  }
  const ids = new Map<string, string>()
  const agents: AgentProfile[] = []
  const start = existing.length * 5
  for (const t of chosen?.members ?? []) {
    const id = newId('puesto')
    ids.set(t.key, id)
    company.members.push({ id, title: t.title, reportsTo: null, collaborates: [], budgetUsd: 0 })
    agents.push(memberAgent(company, company.members[company.members.length - 1], t, pickName(agents.map((a) => a.name), start)))
  }
  for (const [i, t] of (chosen?.members ?? []).entries()) company.members[i].reportsTo = t.reportsTo ? (ids.get(t.reportsTo) ?? null) : null
  return { company, agents }
}

/** Ids and the creation time are random/clock: replace each id by its position so two builds can be compared. */
function normalise({ company, agents }: { company: Company; agents: AgentProfile[] }) {
  const index = new Map(company.members.map((m, i) => [m.id, `puesto-${i}`]))
  const swap = (id: string | null): string | null => (id === null ? null : (index.get(id) ?? id))
  return {
    company: { ...company, id: 'empresa', createdAt: 0, members: company.members.map((m) => ({ ...m, id: swap(m.id)!, reportsTo: swap(m.reportsTo), collaborates: m.collaborates.map((c) => swap(c)!) })) },
    agents: agents.map((a) => ({ ...a, id: swap(a.id)!, companyId: 'empresa' }))
  }
}

describe('buildCompany', () => {
  const templates = companyTemplates('es')

  it('AC-3.3 (029) the form and the tool build the same company', () => {
    for (const existingCount of [0, 2]) {
      const existing = Array.from({ length: existingCount }, (_, i) => existingCompany(`e${i}`))
      for (const chosen of [...templates, undefined]) {
        const name = chosen?.name ?? 'Mi empresa'
        const built = buildCompany(
          { name, mission: chosen?.mission ?? '', goals: chosen?.goals ?? '', vault: 'C:\\v\\x', color: chosen?.color, positions: chosen?.members ?? [] },
          existing
        )
        expect(normalise(built)).toEqual(normalise(legacyCreate(chosen, name, 'C:\\v\\x', existing)))
      }
    }
  })

  it('AC-3.3 (029) existing companies offset the names and the colour', () => {
    const existing = [existingCompany('a'), existingCompany('b'), existingCompany('c')]
    const built = buildCompany({ name: 'X', mission: '', goals: '', vault: 'v', positions: [] }, existing)
    expect(built.company.color).toBe(COMPANY_COLORS[3])
    const withOne = buildCompany({ name: 'X', mission: '', goals: '', vault: 'v', positions: templates[0].members }, existing)
    expect(withOne.agents[0].name).toBe(pickName([], 15))
  })

  it('AC-3.7 (029) a free-form position list is built as given', () => {
    const position = (key: string, reportsTo: string | null, extra: Partial<PositionSpec> = {}): PositionSpec => ({
      key,
      title: `Title ${key}`,
      reportsTo,
      description: `Description ${key}`,
      instructions: `Instructions ${key}`,
      tools: ['read_file'],
      canDelegate: false,
      ...extra
    })
    const { company, agents } = buildCompany(
      {
        name: 'Free',
        mission: 'm',
        goals: 'g',
        vault: 'v',
        budgetUsd: 100,
        positions: [position('a', null, { canDelegate: true, allowMcp: true, autoApprove: ['read_file'], budgetUsd: 7 }), position('b', 'a'), position('c', 'b'), position('d', 'c')]
      },
      []
    )
    expect(company.budgetUsd).toBe(100)
    expect(company.members.map((m) => m.title)).toEqual(['Title a', 'Title b', 'Title c', 'Title d'])
    const byTitle = (title: string) => company.members.find((m) => m.title === title)!
    expect(byTitle('Title a').reportsTo).toBeNull()
    expect(byTitle('Title b').reportsTo).toBe(byTitle('Title a').id)
    expect(byTitle('Title c').reportsTo).toBe(byTitle('Title b').id)
    expect(byTitle('Title d').reportsTo).toBe(byTitle('Title c').id)
    expect(byTitle('Title a').budgetUsd).toBe(7)
    expect(byTitle('Title b').budgetUsd).toBe(0)
    expect(agents.map((a) => a.id)).toEqual(company.members.map((m) => m.id))
    expect(agents[0]).toMatchObject({ description: 'Description a', systemPrompt: 'Instructions a', tools: ['read_file'], autoApproveTools: ['read_file'], canDelegate: true, allowMcp: true, companyId: company.id })
    expect(agents[1]).toMatchObject({ canDelegate: false, allowMcp: false })
  })

  it('AC-6.6 (029) agents are meta / default model / medium', () => {
    const { agents } = buildCompany(
      { name: 'X', mission: '', goals: '', vault: 'v', positions: [{ key: 'a', title: 'A', reportsTo: null, description: '', instructions: '', tools: [], canDelegate: false, allowMcp: true }] },
      []
    )
    expect(agents[0]).toMatchObject({ provider: 'meta', model: DEFAULT_META_MODEL, effort: 'medium' })
  })

  it('AC-6.7 (029) names come from AGENT_NAMES through pickName', () => {
    const positions: PositionSpec[] = Array.from({ length: 8 }, (_, i) => ({ key: `k${i}`, title: `T${i}`, reportsTo: i === 0 ? null : 'k0', description: '', instructions: '', tools: [], canDelegate: false }))
    const { agents } = buildCompany({ name: 'X', mission: '', goals: '', vault: 'v', positions }, [])
    expect(agents.map((a) => a.name)).toEqual(AGENT_NAMES.slice(0, 8))
  })

  it('AC-3.6 (029) omitted budget is 20 and omitted vault is the default path', () => {
    const input = { name: 'X', mission: '', goals: '', vault: 'v', positions: [] }
    expect(buildCompany(input, []).company.budgetUsd).toBe(20)
    expect(buildCompany({ ...input, budgetUsd: 100 }, []).company.budgetUsd).toBe(100)
    const base = 'C:\\Users\\ana\\Documents\\Alma\\Vault'
    expect(defaultCompanyVault(base, 'Acme')).toBe('C:\\Users\\ana\\Documents\\Alma\\Empresas\\Acme')
    expect(defaultCompanyVault(base, ' a\\b/c:d*e?f"g<h>i|j ')).toBe('C:\\Users\\ana\\Documents\\Alma\\Empresas\\a-b-c-d-e-f-g-h-i-j')
    expect(defaultCompanyVault(base, '   ')).toBe('C:\\Users\\ana\\Documents\\Alma\\Empresas\\Empresa')
    expect(defaultCompanyVault(base, '\\/:')).toBe('C:\\Users\\ana\\Documents\\Alma\\Empresas\\---')
    // Windows drops a trailing dot or space on its own, so the folder would not be the one that was checked.
    expect(defaultCompanyVault(base, 'Acme. . ')).toBe('C:\\Users\\ana\\Documents\\Alma\\Empresas\\Acme')
    expect(defaultCompanyVault(base, '...')).toBe('C:\\Users\\ana\\Documents\\Alma\\Empresas\\Empresa')
    expect(defaultCompanyVault(base, 'A\r\nB\x00')).toBe('C:\\Users\\ana\\Documents\\Alma\\Empresas\\A--B-')
    expect(defaultCompanyVault('C:/Users/ana/Documents/Alma/Vault', 'Acme')).toBe('C:/Users/ana/Documents/Alma\\Empresas\\Acme')
    expect(defaultCompanyVault(`${base}\\`, 'Acme')).toBe('C:\\Users\\ana\\Documents\\Alma\\Empresas\\Acme')
  })

  it('AC-3.8 (029) mailbox is empty and WhatsApp off', () => {
    const { company } = buildCompany({ name: 'X', mission: '', goals: '', vault: 'v', positions: [] }, [])
    expect(company.email).toEqual({ address: '', imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 465 })
    expect(company.whatsapp).toBe(false)
    expect(company.budgetUsd).toBe(20)
  })
})

const head = (extra: Partial<PositionSpec> = {}): PositionSpec => ({ key: 'a', title: 'Head', reportsTo: null, description: 'd', instructions: 'i', tools: ['read_file'], canDelegate: false, ...extra })
const valid = (extra: Partial<NewCompanyInput> = {}): NewCompanyInput => ({ name: 'Acme', mission: 'm', goals: 'g', vault: 'v', positions: [head()], ...extra })
const ctx = (existing: Company[] = []) => ({ existing, catalogue: ['read_file', 'write_file', 'run_command'] as readonly string[] })
const codes = (input: NewCompanyInput, existing: Company[] = []) => companyIssues(input, ctx(existing)).map((i) => i.code)

describe('companyIssues', () => {
  it('a valid input has no issues', () => {
    expect(companyIssues(valid(), ctx())).toEqual([])
  })

  it('AC-5.7 (029) name, colour, mission and goals', () => {
    expect(codes(valid({ name: '' }))).toEqual(['name.empty'])
    expect(codes(valid({ name: '   ' }))).toEqual(['name.empty'])
    expect(codes(valid({ name: 'x'.repeat(60) }))).toEqual([])
    expect(codes(valid({ name: 'x'.repeat(61) }))).toEqual(['name.long'])
    const taken = [{ ...existingCompany('e'), name: 'Acme Corp' }]
    expect(codes(valid({ name: 'Acme Corp' }), taken)).toEqual(['name.taken'])
    expect(codes(valid({ name: '  ACME corp ' }), taken)).toEqual(['name.taken'])
    expect(codes(valid({ name: 'Acme Corp 2' }), taken)).toEqual([])
    expect(codes(valid({ color: COMPANY_COLORS[7] }))).toEqual([])
    expect(codes(valid({ color: '#000000' }))).toEqual(['color.unknown'])
    expect(codes(valid({ color: '' }))).toEqual(['color.unknown'])
    expect(codes(valid({ mission: 'x'.repeat(500) }))).toEqual([])
    expect(codes(valid({ mission: 'x'.repeat(501) }))).toEqual(['mission.long'])
    expect(codes(valid({ goals: 'x'.repeat(1000) }))).toEqual([])
    expect(codes(valid({ goals: 'x'.repeat(1001) }))).toEqual(['goals.long'])
  })

  it('AC-5.4 (029) budget ceilings', () => {
    const company = (budgetUsd: number) => companyIssues(valid({ budgetUsd }), ctx())
    const member = (budgetUsd: number) => companyIssues(valid({ positions: [head({ budgetUsd })] }), ctx())
    for (const ok of [0.01, 20, 100]) {
      expect(company(ok)).toEqual([])
      expect(member(ok)).toEqual([])
    }
    for (const bad of [0, 100.01, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(company(bad)).toEqual([{ code: 'budget.range', scope: 'company', max: 100 }])
      expect(member(bad)).toEqual([{ code: 'budget.range', scope: 'member', max: 100 }])
    }
    // Omitted: nothing to reject, and the builder fills 20 for the company and 0 for the member.
    const omitted = valid()
    expect(companyIssues(omitted, ctx())).toEqual([])
    const built = buildCompany(omitted, [])
    expect([built.company.budgetUsd, built.company.members[0].budgetUsd]).toEqual([20, 0])
  })

  const seat = (key: string, reportsTo: string | null) => head({ key, reportsTo })
  const chain = (n: number) => Array.from({ length: n }, (_, i) => seat(`k${i}`, i === 0 ? null : `k${i - 1}`))
  const fan = (n: number) => Array.from({ length: n }, (_, i) => seat(`k${i}`, i === 0 ? null : 'k0'))
  const orgIssues = (positions: PositionSpec[]) => companyIssues(valid({ positions }), ctx())

  it('AC-5.5 (029) at most 8 positions', () => {
    expect(orgIssues(fan(1))).toEqual([])
    expect(orgIssues(fan(8))).toEqual([])
    expect(orgIssues(fan(9))).toEqual([{ code: 'positions.many', max: 8 }])
    expect(orgIssues([])).toEqual([{ code: 'positions.none' }])
  })

  it('AC-5.6 (029) exactly one head, at most 4 levels, no loops', () => {
    expect(orgIssues(chain(4))).toEqual([])
    expect(orgIssues(chain(5))).toEqual([{ code: 'org.deep', at: 'k4' }])
    expect(orgIssues([seat('a', null), seat('b', null)])).toEqual([{ code: 'org.manyHeads' }])
    expect(orgIssues([seat('a', 'b'), seat('b', 'a')])).toEqual([{ code: 'org.noHead' }, { code: 'org.loop', at: 'a' }])
    expect(orgIssues([seat('a', null), seat('b', 'b')])).toEqual([{ code: 'org.loop', at: 'b' }])
    expect(orgIssues([seat('a', null), seat('b', 'c'), seat('c', 'b')])).toEqual([{ code: 'org.loop', at: 'b' }])
    expect(orgIssues([seat('a', null), seat('b', 'zzz')])).toEqual([{ code: 'org.unknownBoss', at: 'b' }])
    expect(orgIssues([seat('a', null), seat('a', 'a')])).toEqual([{ code: 'org.duplicateKey', at: 'a' }])
  })

  it('AC-5.6 (029) an empty key is refused, and the builder never turns an unknown boss into the board', () => {
    expect(orgIssues([seat('a', null), seat('', 'a')])).toEqual([{ code: 'key.empty' }])
    expect(orgIssues([seat('a', null), seat('b', '')])).toEqual([{ code: 'org.unknownBoss', at: 'b' }])
    expect(() => buildCompany(valid({ positions: [seat('a', null), seat('b', '')] }), [])).toThrow(/Unknown boss key/)
    expect(() => buildCompany(valid({ positions: [seat('a', null), seat('b', 'zzz')] }), [])).toThrow(/Unknown boss key/)
  })

  it('AC-5.5 (029) a huge list is refused before the loop and depth checks', () => {
    const started = Date.now()
    expect(orgIssues(chain(1200))).toEqual([{ code: 'positions.many', max: 8 }])
    expect(Date.now() - started).toBeLessThan(100)
  })

  it('AC-5.8 (029) description plus instructions at most 2000', () => {
    const brief = (description: number, instructions: number) => orgIssues([head({ description: 'd'.repeat(description), instructions: 'i'.repeat(instructions) })])
    expect(brief(0, 2000)).toEqual([])
    expect(brief(1000, 1000)).toEqual([])
    expect(brief(2000, 0)).toEqual([])
    expect(brief(1000, 1001)).toEqual([{ code: 'brief.long', at: 'a', max: 2000 }])
    expect(brief(2001, 0)).toEqual([{ code: 'brief.long', at: 'a', max: 2000 }])
    expect(orgIssues([seat('a', null), head({ key: 'b', reportsTo: 'a', instructions: 'i'.repeat(2001) })])).toEqual([{ code: 'brief.long', at: 'b', max: 2000 }])
  })

  it('AC-6.3 (029) an unknown tool name fails', () => {
    expect(orgIssues([head({ tools: ['read_file', 'write_file'], autoApprove: ['read_file'] })])).toEqual([])
    for (const tool of ['create_company', 'mcp__x__y', '', 'Read_File', 'read_file ']) {
      expect(orgIssues([head({ tools: [tool] })])).toEqual([{ code: 'tool.unknown', at: 'a', tool }])
      expect(orgIssues([head({ autoApprove: [tool] })])).toEqual([{ code: 'tool.unknown', at: 'a', tool }])
    }
    expect(orgIssues([head({ tools: ['nope'], autoApprove: ['nope', 'run_command'] })])).toEqual([{ code: 'tool.unknown', at: 'a', tool: 'nope' }])
    expect(orgIssues([seat('a', null), head({ key: 'b', reportsTo: 'a', tools: ['nope'] })])).toEqual([{ code: 'tool.unknown', at: 'b', tool: 'nope' }])
  })

  it('AC-5.9 (029) ten companies at most', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => existingCompany(`e${i}`))
    expect(codes(valid(), many(9))).toEqual([])
    expect(companyIssues(valid(), ctx(many(10)))).toEqual([{ code: 'companies.full', max: 10 }])
    expect(codes(valid(), many(11))).toEqual(['companies.full'])
  })

  describe('proposalOfCreation', () => {
    const risks: Record<string, string> = { read_file: 'read', write_file: 'write', run_command: 'exec', instagram_publish: 'publish' }
    const riskOf = (tool: string) => risks[tool]

    it('AC-2.1 (029) the proposal lists every field of every position', () => {
      const positions: PositionSpec[] = [
        head({ key: 'ceo', title: 'CEO', description: 'Runs it', instructions: 'i'.repeat(2000 - 'Runs it'.length), tools: ['read_file', 'write_file'], autoApprove: ['write_file'], canDelegate: true, allowMcp: true }),
        ...Array.from({ length: 7 }, (_, i) => seat(`k${i}`, i === 0 ? 'ceo' : 'k0'))
      ]
      const view = proposalOfCreation(valid({ name: 'Acme', vault: 'E:/Empresas/Acme', budgetUsd: 50, positions }), riskOf)
      expect(view).toMatchObject({ kind: 'create', company: 'Acme', vault: 'E:/Empresas/Acme', budgetUsd: 50, briefHeaderAdded: true })
      expect(view.positions).toHaveLength(8)
      expect(view.positions[0]).toEqual({
        title: 'CEO',
        boss: null,
        description: 'Runs it',
        instructions: positions[0].instructions,
        tools: ['read_file', 'write_file'],
        autoApprove: ['write_file'],
        canDelegate: true,
        allowMcp: true,
        runsCommandsUnasked: false,
        budgetUsd: 0
      })
      expect(view.positions[0].instructions).toHaveLength(2000 - 'Runs it'.length)
      expect(view.positions[1]).toMatchObject({ title: 'Head', boss: 'CEO', autoApprove: [], canDelegate: false, allowMcp: false })
      expect(view.positions[2].boss).toBe('Head')
      // the omitted budget is shown as what will be saved
      expect(proposalOfCreation(valid(), riskOf).budgetUsd).toBe(20)
    })

    it('AC-2.1 (029) whether the brief header is added is told by the caller, who applies it', () => {
      expect(proposalOfCreation(valid(), riskOf).briefHeaderAdded).toBe(true)
      expect(proposalOfCreation(valid(), riskOf, 0, false).briefHeaderAdded).toBe(false)
    })

    it('AC-6.1 (029) every field the builder saves from the input is shown by the proposal', () => {
      // `Required<…>`: a field added to the input types stops compiling here until it is given a value and a place in the view.
      const full: Required<NewCompanyInput> = {
        name: 'NAME-sentinel',
        mission: 'MISSION-sentinel',
        goals: 'GOALS-sentinel',
        vault: 'E:/Empresas/VAULT-sentinel',
        color: COMPANY_COLORS[3],
        budgetUsd: 37.5,
        positions: [
          { key: 'k-ceo', title: 'TITLE-ceo', reportsTo: null, description: 'DESC-ceo', instructions: 'INSTR-ceo', tools: ['TOOL-ceo'], autoApprove: ['AUTO-ceo'], canDelegate: true, allowMcp: true, budgetUsd: 12.25 } satisfies Required<PositionSpec>,
          { key: 'k-dev', title: 'TITLE-dev', reportsTo: 'k-ceo', description: 'DESC-dev', instructions: 'INSTR-dev', tools: ['TOOL-dev'], autoApprove: ['AUTO-dev'], canDelegate: false, allowMcp: false, budgetUsd: 7.75 } satisfies Required<PositionSpec>
        ]
      }
      const view = proposalOfCreation(full, () => undefined)
      const { company, agents } = buildCompany(full, [])
      const shown = JSON.stringify(view)
      const saved = [company.name, company.mission, company.goals, company.vault, company.color, company.budgetUsd, ...company.members.flatMap((m) => [m.title, m.budgetUsd]), ...agents.flatMap((a) => [a.description, a.systemPrompt, ...a.tools, ...(a.autoApproveTools ?? [])])]
      for (const value of saved) expect(shown, String(value)).toContain(typeof value === 'string' ? JSON.stringify(value).slice(1, -1) : String(value))
      expect(view.positions.map((p) => [p.canDelegate, p.allowMcp])).toEqual(agents.map((a) => [a.canDelegate, a.allowMcp]))
      expect(view.positions[1].boss).toBe('TITLE-ceo')
    })

    it('AC-6.1 (029) an omitted colour is shown as the one the builder picks', () => {
      for (const existing of [0, 3, 8, 9]) {
        const view = proposalOfCreation(valid(), riskOf, existing)
        const { company } = buildCompany(valid(), Array.from({ length: existing }, (_, i) => existingCompany(`e${i}`)))
        expect(view.color).toBe(company.color)
      }
    })

    it('AC-2.11 (029) a position auto-approving an exec tool is flagged', () => {
      const flag = (autoApprove?: string[]) => proposalOfCreation(valid({ positions: [head({ tools: ['run_command', 'read_file', 'instagram_publish'], autoApprove })] }), riskOf).positions[0].runsCommandsUnasked
      expect(flag(['run_command'])).toBe(true)
      expect(flag(['read_file', 'run_command'])).toBe(true)
      expect(flag(['read_file'])).toBe(false)
      expect(flag(['instagram_publish'])).toBe(false)
      expect(flag([])).toBe(false)
      expect(flag(undefined)).toBe(false)
      expect(flag(['not_in_the_catalogue'])).toBe(false)
      // the flag is per position
      const two = proposalOfCreation(valid({ positions: [head({ autoApprove: ['run_command'] }), seat('b', 'a')] }), riskOf)
      expect(two.positions.map((p) => p.runsCommandsUnasked)).toEqual([true, false])
    })
  })

  it('AC-2.12 (029) canAnswerFrom is false for telegram and phone when the input does not fit', () => {
    // JSON.stringify(input, null, 1) of { text } adds a fixed framing around the text; size the text so the whole is `total`.
    const framing = JSON.stringify({ text: '' }, null, 1).length
    const sized = (toolName: string, total: number) => ({ toolName, input: { text: 'x'.repeat(total - framing) } })
    expect(JSON.stringify(sized('create_company', 1500).input, null, 1)).toHaveLength(1500)
    expect([...COMPANY_AUTHORING_TOOLS]).toEqual(['create_company', 'edit_company'])
    for (const tool of COMPANY_AUTHORING_TOOLS) {
      for (const via of ['telegram', 'phone'] as const) {
        expect(canAnswerFrom(via, sized(tool, 1500), 1500)).toBe(true)
        expect(canAnswerFrom(via, sized(tool, 1501), 1500)).toBe(false)
      }
      expect(canAnswerFrom('desktop', sized(tool, 1501), 1500)).toBe(true)
      expect(canAnswerFrom('desktop', sized(tool, 100_000), 1500)).toBe(true)
    }
    // Any other tool keeps the old behavior: the channel shows the cut text and may answer.
    expect(canAnswerFrom('telegram', sized('write_file', 5000), 1500)).toBe(true)
    expect(canAnswerFrom('phone', sized('send_email', 5000), 1500)).toBe(true)
    // WhatsApp and voice show none of the proposal: they never allow a company tool, and answer every other tool as before
    for (const via of ['whatsapp', 'voice'] as const) {
      for (const tool of COMPANY_AUTHORING_TOOLS) expect(canAnswerFrom(via, sized(tool, 100), 1500)).toBe(false)
      expect(canAnswerFrom(via, sized('send_email', 5000), 1500)).toBe(true)
    }
  })

  describe('vaultIssues', () => {
    const base = 'C:\\Users\\ana\\Documents\\Alma\\Vault'
    const root = 'C:\\Users\\ana\\Documents\\Alma\\Empresas'
    const check = (vault: string, extra: Partial<Parameters<typeof vaultIssues>[1]> = {}) => vaultIssues(vault, { defaultVaultPath: base, reserved: [base], hasFiles: false, ...extra }).map((i) => i.code)

    it('AC-5.3 (029) vault folder rules', () => {
      expect(check(`${root}\\Acme`)).toEqual([])
      expect(check(`${root}\\Acme\\`)).toEqual([])
      expect(check('C:/Users/ana/Documents/Alma/Empresas/Acme')).toEqual([])
      expect(check('c:\\users\\ANA\\documents\\alma\\EMPRESAS\\Acme')).toEqual([])
      expect(vaultIssues(`${root}\\Acme`, { defaultVaultPath: `${base}\\`, reserved: [], hasFiles: false })).toEqual([])
      expect(vaultIssues('C:\\Empresas\\Acme', { defaultVaultPath: 'C:\\Vault', reserved: [], hasFiles: false })).toEqual([])
      // outside the Empresas folder
      for (const bad of [
        base,
        root,
        `${root}\\`,
        'C:\\Users\\ana\\Documents\\Alma\\Otras\\Acme',
        'C:\\Users\\ana\\Documents\\Alma\\EmpresasX\\Acme',
        '\\\\server\\share\\Alma\\Empresas\\Acme',
        '//server/share/Alma/Empresas/Acme',
        'C:Users\\ana\\Documents\\Alma\\Empresas\\Acme',
        '\\Users\\ana\\Documents\\Alma\\Empresas\\Acme',
        'Empresas\\Acme',
        ''
      ])
        expect(check(bad), bad).toEqual(['vault.outside'])
      // dot segments, even when they would resolve back inside
      for (const bad of [`${root}\\..\\Empresas\\Acme`, `${root}\\.\\Acme`, `${root}\\Acme\\..`, '..\\Acme']) expect(check(bad), bad).toEqual(['vault.dots'])
      // forbidden characters in the name part, and a name part that is not a single folder
      for (const bad of ['a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'a\\b', 'a/b']) expect(check(`${root}\\${bad}`), bad).toEqual(['vault.chars'])
      // a folder that already holds files, the main vault, another company's vault
      expect(check(`${root}\\Acme`, { hasFiles: true })).toEqual(['vault.notEmpty'])
      expect(check(`${root}\\Acme`, { reserved: [base, `${root}\\Acme`] })).toEqual(['vault.reserved'])
      expect(check(`${root}\\Acme`, { reserved: ['c:/users/ana/documents/alma/empresas/ACME/'] })).toEqual(['vault.reserved'])
      expect(check(`${root}\\Acme`, { reserved: [`${root}\\Other`] })).toEqual([])
      expect(check(`${root}\\Acme`, { hasFiles: true, reserved: [`${root}\\Acme`] })).toEqual(['vault.notEmpty', 'vault.reserved'])
    })

    it('AC-5.3 (029) refuses names Windows cannot create: control characters, trailing dot or space, device names', () => {
      for (const bad of ['a\x00b', 'a\x1fb', 'a\tb', 'Acme.', 'Acme ', 'Acme..', 'CON', 'con', 'Nul', 'PRN', 'AUX', 'COM1', 'com9', 'LPT1', 'lpt9', 'CON.txt', 'aux.v1.md'])
        expect(check(`${root}\\${bad}`), JSON.stringify(bad)).toEqual(['vault.chars'])
      for (const good of ['COM0', 'COM10', 'LPT0', 'CONSOLE', 'Acme.v2', 'xCON', 'Acme 2', '.hidden'])
        expect(check(`${root}\\${good}`), good).toEqual([])
    })
  })
})
