import { describe, expect, it } from 'vitest'
import { phoneDigits } from '../src/coordinator/channels/whatsapp'
import { emailServersFor } from '../src/shared/defaults'
import { describeDrawing, parseDrawing, queueOp } from '../src/shared/excalidraw'

describe('integrations', () => {
  it('guesses the mail servers from the address', () => {
    expect(emailServersFor('vos@gmail.com')).toEqual({ imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465 })
    expect(emailServersFor('vos@hotmail.com.ar').smtpHost).toBe('smtp-mail.outlook.com')
    expect(emailServersFor('ventas@miempresa.com.ar')).toMatchObject({ imapHost: 'imap.miempresa.com.ar', smtpHost: 'smtp.miempresa.com.ar' })
    expect(emailServersFor('sin-arroba')).toEqual({})
  })

  it('keeps only the digits of a phone number', () => {
    expect(phoneDigits('+54 9 11 1234-5678')).toBe('5491112345678')
  })
})

describe('drawings', () => {
  it('queues agent ops and describes a drawing by id, label and connections', () => {
    const queued = parseDrawing(queueOp('', { mermaid: 'flowchart LR\n A-->B' }))
    expect(queued.alma?.ops).toHaveLength(1)
    const elements = [
      { id: 'r1', type: 'rectangle', x: 0, y: 0, width: 100, height: 50, boundElements: [{ id: 't1', type: 'text' }] },
      { id: 't1', type: 'text', x: 10, y: 10, width: 80, height: 20, text: 'Lanzamient\no', originalText: 'Lanzamiento', containerId: 'r1' },
      { id: 'a1', type: 'arrow', x: 100, y: 25, width: 50, height: 0, startBinding: { elementId: 'r1' }, endBinding: { elementId: 'r2' } },
      { id: 'gone', type: 'ellipse', x: 0, y: 0, width: 1, height: 1, isDeleted: true }
    ]
    expect(describeDrawing(elements)).toBe('- r1 rectangle «Lanzamiento» (0,0 100×50)\n- a1 arrow (100,25 50×0) desde r1 hasta r2')
    expect(describeDrawing(elements, new Set(['a1']))).toBe('- a1 arrow (100,25 50×0) desde r1 hasta r2')
  })
})
