import { describe, expect, it } from 'vitest'
import { authorizeChat, splitForTelegram } from '../src/coordinator/channels/telegram'
import type { TelegramSettings } from '../src/shared/types'

const config = (over: Partial<TelegramSettings> = {}): TelegramSettings => ({
  enabled: true,
  allowedUsers: ['@Felix'],
  agentId: 'general',
  chatId: null,
  threadId: null,
  ...over
})

describe('authorizeChat', () => {
  it('binds the first allowed user in a private chat, case-insensitively and ignoring @', () => {
    expect(authorizeChat(config(), { id: 7, type: 'private' }, 'felix')).toBe('bind')
    expect(authorizeChat(config(), { id: 7, type: 'private' }, 'otro')).toBe('denied')
    expect(authorizeChat(config(), { id: 7, type: 'private' }, undefined)).toBe('denied')
  })

  it('never accepts groups, even from an allowed user', () => {
    expect(authorizeChat(config(), { id: -100, type: 'group' }, 'felix')).toBe('denied')
    expect(authorizeChat(config({ chatId: -100 }), { id: -100, type: 'supergroup' }, 'felix')).toBe('denied')
  })

  it('once bound, only that chat works, whatever the username', () => {
    const bound = config({ chatId: 7 })
    expect(authorizeChat(bound, { id: 7, type: 'private' }, 'nuevo_nombre')).toBe('ok')
    expect(authorizeChat(bound, { id: 8, type: 'private' }, 'felix')).toBe('denied')
  })
})

describe('splitForTelegram', () => {
  it('keeps short text whole and splits long text at line breaks under the limit', () => {
    expect(splitForTelegram('hola')).toEqual(['hola'])
    const long = Array.from({ length: 50 }, (_, i) => `Línea ${i} ${'x'.repeat(90)}`).join('\n')
    const pieces = splitForTelegram(long, 1000)
    expect(pieces.length).toBeGreaterThan(4)
    expect(pieces.every((p) => p.length <= 1000)).toBe(true)
    expect(pieces.join('\n')).toBe(long)
  })
})
