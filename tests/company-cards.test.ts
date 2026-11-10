import { describe, expect, it } from 'vitest'
import { en } from '../src/shared/i18n/en'
import { es } from '../src/shared/i18n/es'

const PROPOSAL_KEYS = [
  'company.proposal.company',
  'company.proposal.mission',
  'company.proposal.goals',
  'company.proposal.color',
  'company.proposal.memberBudget',
  'company.proposal.vault',
  'company.proposal.budget',
  'company.proposal.positions',
  'company.proposal.reportsTo',
  'company.proposal.reportsToBoard',
  'company.proposal.description',
  'company.proposal.instructions',
  'company.proposal.tools',
  'company.proposal.autoApprove',
  'company.proposal.none',
  'company.proposal.canDelegate',
  'company.proposal.cannotDelegate',
  'company.proposal.mcpOn',
  'company.proposal.mcpOff',
  'company.proposal.runsCommands',
  'company.proposal.briefHeader',
  'company.proposal.readOnly'
] as const

describe('company tool cards (029 T32)', () => {
  it('AC-7.1 (029) both dictionaries have the labels and proposal texts', () => {
    for (const dictionary of [es, en] as Record<string, unknown>[]) {
      for (const key of [...PROPOSAL_KEYS, 'toolLabel.create_company']) expect(dictionary[key], key).toBeTruthy()
    }
  })
})
