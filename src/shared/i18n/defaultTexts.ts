import { enDefaults } from './en/defaults'
import { esDefaults } from './es/defaults'
import type { Language } from './language'

export interface AgentTexts {
  name: string
  description: string
  systemPrompt: string
}

export interface MemberTexts {
  title: string
  description: string
  instructions: string
}

export interface TemplateTexts {
  name: string
  mission: string
  goals: string
  members: Record<string, MemberTexts>
}

/** Everything shipped as editable content that is written in words: it follows the language in effect at first load (BR-16). */
export interface DefaultTexts {
  agents: Record<string, AgentTexts>
  reviewInstructions: string
  templates: Record<string, TemplateTexts>
}

export const defaultTexts = (language: Language): DefaultTexts => (language === 'en' ? enDefaults : esDefaults)
