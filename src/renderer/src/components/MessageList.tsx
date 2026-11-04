import { useMemo, useState } from 'react'
import type { Block, ChatMessage, PendingApproval, Thread } from '../../../shared/types'
import type { Draft } from '../lib/state'
import { splitMessage } from '../../../shared/attachments'
import { useT } from '../i18n/useT'
import { Markdown } from './Markdown'
// biome-ignore lint/suspicious/noImportCycles: tool cards render nested message lists (sub-agent runs)
import { ToolCard } from './ToolCard'
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react'
import { Icon } from '../umbra/Icon'

type ToolResult = Extract<Block, { type: 'tool_result' }>

interface Props {
  thread: Thread
  messages: ChatMessage[]
  draft?: Draft
  drafts: Record<string, Draft>
  approvals: PendingApproval[]
  running: boolean
}

function Thinking({ text, live }: { text: string; live?: boolean }): React.JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false)
  return (
    <div className="thinking">
      <button className="thinking-toggle" onClick={() => setOpen(!open)}>
        {live ? <span className="spinner" /> : <Icon icon={Sparkles} size="sm" />} {t('chat.reasoning')} {open ? <Icon icon={ChevronDown} size="sm" /> : <Icon icon={ChevronRight} size="sm" />}
      </button>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  )
}

export function MessageList({ thread, messages, draft, drafts, approvals, running }: Props): React.JSX.Element {
  const t = useT()
  const results = useMemo(() => {
    const map = new Map<string, ToolResult>()
    for (const message of messages) {
      for (const block of message.content) if (block.type === 'tool_result') map.set(block.tool_use_id, block)
    }
    return map
  }, [messages])

  const committedToolIds = useMemo(
    () => new Set(messages.flatMap((m) => m.content.filter((b) => b.type === 'tool_use').map((b) => (b as { id: string }).id))),
    [messages]
  )

  const renderTool = (block: Extract<Block, { type: 'tool_use' }>): React.JSX.Element => (
    <ToolCard
      key={block.id}
      thread={thread}
      use={block}
      result={results.get(block.id)}
      state={thread.toolStates[block.id]}
      approval={approvals.find((a) => a.toolUseId === block.id)}
      drafts={drafts}
      approvals={approvals}
    />
  )

  const last = messages[messages.length - 1]
  const waitingForModel = running && !draft && (!last || last.role === 'user')

  return (
    <div className="message-list">
      {messages.map((message, index) => {
        if (message.role === 'user') {
          const text = message.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n')
          if (!text) return null
          const sent = splitMessage(text)
          return (
            <div key={index} className="msg user">
              <div className="bubble">
                {sent.text}
                {sent.count > 0 && (
                  <details className="sent-attachments">
                    <summary>{t('chat.attachmentsFolded', { count: sent.count })}</summary>
                    <pre>{sent.attachments}</pre>
                  </details>
                )}
              </div>
            </div>
          )
        }
        return (
          <div key={index} className="msg assistant">
            {message.content.map((block, i) => {
              if (block.type === 'thinking') return <Thinking key={i} text={block.thinking} />
              if (block.type === 'text') return <Markdown key={i} text={block.text} />
              if (block.type === 'tool_use') return renderTool(block)
              return null
            })}
            {message.notice && <div className="notice">{message.notice}</div>}
          </div>
        )
      })}

      {draft && (
        <div className="msg assistant live">
          {draft.thinking && !draft.text && draft.tools.length === 0 && <Thinking text={draft.thinking} live />}
          {draft.text && <Markdown text={draft.text} />}
          {draft.tools
            .filter((tool) => !committedToolIds.has(tool.id))
            .map((tool) => (
              <div key={tool.id} className="tool-card pending">
                <div className="tool-head">
                  <span className="spinner" /> <strong>{tool.name}</strong> <span className="muted">{t('chat.preparing')}</span>
                </div>
              </div>
            ))}
        </div>
      )}

      {waitingForModel && (
        <div className="msg assistant">
          <div className="working">
            <span className="spinner" /> {t('chat.thinking')}
          </div>
        </div>
      )}
    </div>
  )
}
