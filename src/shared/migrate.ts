import { defaultTexts, type MemberTexts } from './i18n/defaultTexts'
import type { Language } from './i18n/language'
import type { AgentProfile, Company, Settings } from './types'

/**
 * Moves the shipped words to a new language, but only the ones nobody touched (spec 025 BR-16, AC-8.2): a default agent,
 * a company made from a template or the auto-review instructions that are still identical to the shipped copy of
 * `from` are rewritten with the shipped copy of `to`. Anything the person edited, any default they deleted and any
 * agent they made themselves stays byte for byte as it is (AC-4.1).
 */
export function migrateDefaults(settings: Settings, from: Language, to: Language): Settings {
  if (from === to) return settings
  const was = defaultTexts(from)
  const now = defaultTexts(to)

  // Which template position (if any) an agent of a company still is, word for word.
  const matched = new Map<string, { was: MemberTexts; now: MemberTexts }>()
  const agents = settings.agents.map((agent): AgentProfile => {
    if (agent.companyId) {
      for (const [templateId, template] of Object.entries(was.templates)) {
        for (const [key, words] of Object.entries(template.members)) {
          if (agent.description === words.description && agent.systemPrompt === words.instructions) {
            const next = now.templates[templateId]?.members[key]
            if (!next) continue
            matched.set(`${agent.companyId}/${agent.id}`, { was: words, now: next })
            return { ...agent, description: next.description, systemPrompt: next.instructions }
          }
        }
      }
      return agent
    }
    const before = was.agents[agent.id]
    const after = now.agents[agent.id]
    if (!before || !after) return agent
    const untouched = agent.name === before.name && agent.description === before.description && agent.systemPrompt === before.systemPrompt
    return untouched ? { ...agent, name: after.name, description: after.description, systemPrompt: after.systemPrompt } : agent
  })

  const companies = settings.companies.map((company): Company => {
    const members = company.members.map((member) => {
      const hit = matched.get(`${company.id}/${member.id}`)
      return hit && member.title === hit.was.title ? { ...member, title: hit.now.title } : member
    })
    const template = Object.entries(was.templates).find(([, t]) => company.name === t.name && company.mission === t.mission && company.goals === t.goals)
    const next = template && now.templates[template[0]]
    return next ? { ...company, name: next.name, mission: next.mission, goals: next.goals, members } : { ...company, members }
  })

  return {
    ...settings,
    agents,
    companies,
    autoReview: settings.autoReview.instructions === was.reviewInstructions ? { ...settings.autoReview, instructions: now.reviewInstructions } : settings.autoReview
  }
}
