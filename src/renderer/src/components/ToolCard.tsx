import { useEffect, useState } from 'react'
import type { Block, PendingApproval, Thread, ToolState } from '../../../shared/types'
import { shownToolText } from '../../../shared/i18n/messages'
import { useLanguage, useT, type T } from '../i18n/useT'
import { request } from '../lib/coordinator'
import { generatedImagePath, reviewerReasonShown } from '../../../shared/cards'
import { knowledgeNotePath, toolLabel, toolSummary } from '../lib/format'
import { openNote } from '../vault/vaultLib'
import type { Draft } from '../lib/state'
import { CompanyProposalCard } from './CompanyProposalCard'
// biome-ignore lint/suspicious/noImportCycles: tool cards render nested message lists (sub-agent runs)
import { MessageList } from './MessageList'
import { WorkspaceImage } from './WorkspaceImage'
import { Ban, Check, ChevronDown, ChevronRight, X } from 'lucide-react'
import { Icon } from '../umbra/Icon'

interface Props {
  thread: Thread
  use: Extract<Block, { type: 'tool_use' }>
  result?: Extract<Block, { type: 'tool_result' }>
  state?: ToolState
  approval?: PendingApproval
  drafts: Record<string, Draft>
  approvals: PendingApproval[]
}

const statusText = (status: ToolState['status'], t: T): string => t(`toolcard.status.${status}`)

function statusIcon(status: ToolState['status'] | undefined): React.JSX.Element {
  switch (status) {
    case 'running':
    case 'reviewing':
      return <span className="spinner" />
    case 'pending-approval':
      return <span className="status-icon warn">!</span>
    case 'done':
      return <span className="status-icon ok"><Icon icon={Check} size={14} /></span>
    case 'denied':
      return <span className="status-icon muted"><Icon icon={Ban} size={14} /></span>
    case 'error':
      return <span className="status-icon danger"><Icon icon={X} size={14} /></span>
    default:
      return <span className="status-icon muted">·</span>
  }
}

function PostPreview({ image, caption, note }: { image?: React.ReactNode; caption?: string; note?: string }): React.JSX.Element {
  return (
    <div className="post-preview">
      {image}
      <div className="post-caption">{caption}</div>
      {note && <div className="small text-warn">{note}</div>}
    </div>
  )
}

function InputDetails({ name, input, threadId }: { name: string; input: unknown; threadId: string }): React.JSX.Element {
  const data = (input ?? {}) as Record<string, unknown>
  if (name === 'instagram_publish') {
    return (
      <PostPreview
        image={typeof data.image_path === 'string' ? <WorkspaceImage threadId={threadId} path={data.image_path} /> : undefined}
        caption={String(data.caption ?? '')}
      />
    )
  }
  if (name === 'generate_image') return <div className="subagent-task">{String(data.prompt ?? '')}</div>
  if (name === 'run_command') return <pre className="code">{String(data.command ?? '')}</pre>
  if (name === 'write_file') {
    return (
      <>
        <div className="detail-label">{String(data.path ?? '')}</div>
        <pre className="code">{String(data.content ?? '')}</pre>
      </>
    )
  }
  if (name === 'edit_file') {
    return (
      <>
        <div className="detail-label">{String(data.path ?? '')}</div>
        <pre className="code diff-del">{String(data.old_string ?? '')}</pre>
        <pre className="code diff-add">{String(data.new_string ?? '')}</pre>
      </>
    )
  }
  return <pre className="code">{JSON.stringify(input, null, 2)}</pre>
}

function Elapsed({ from, to }: { from: number; to?: number }): React.JSX.Element {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (to) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [to])
  const seconds = Math.max(0, Math.round(((to ?? now) - from) / 1000))
  return <span className="muted small">{seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`}</span>
}

export function ToolCard({ thread, use, result, state, approval, drafts, approvals }: Props): React.JSX.Element {
  const t = useT()
  const language = useLanguage()
  // What Alma wrote for the card follows the language of the moment (a live switch included); older results show as stored.
  const shown = result ? shownToolText(result, language) : undefined
  const isDelegate = use.name === 'delegate_task'
  const run = isDelegate ? thread.subagents[use.id] : undefined
  const [open, setOpen] = useState(false)
  // A subagent waiting for approval keeps its card open so the buttons are visible.
  const subagentNeedsApproval = !!run && approvals.some((a) => a.subagentId === run.id)
  const expanded = open || subagentNeedsApproval
  const status = approval ? 'pending-approval' : state?.status
  const generatedPath = (use.name === 'generate_image' || use.name === 'compose_image') && result && !result.is_error ? generatedImagePath(result.content) : undefined
  const notePath = result && !result.is_error ? knowledgeNotePath(use.name, use.input, result.content, language) : undefined
  const respond = (decision: 'allow' | 'deny' | 'always'): void => {
    if (approval) void request({ method: 'approval.respond', approvalId: approval.approvalId, decision })
  }

  return (
    <div className={`tool-card status-${status ?? 'unknown'}${isDelegate ? ' delegate' : ''}`}>
      <button className="tool-head" onClick={() => setOpen(!expanded)} aria-expanded={expanded}>
        {statusIcon(status)}
        <strong>{isDelegate && run ? `${run.agentName}` : toolLabel(use.name, t)}</strong>
        <span className="tool-summary ellipsis">{toolSummary(use.name, use.input, t)}</span>
        {run && <Elapsed from={run.startedAt} to={run.endedAt} />}
        <span className="muted small">{expanded ? <Icon icon={ChevronDown} size={14} /> : <Icon icon={ChevronRight} size={14} />}</span>
      </button>

      {generatedPath && <div className="tool-media"><WorkspaceImage threadId={thread.id} path={generatedPath} /></div>}

      {notePath && (use.name === 'save_knowledge' || use.name === 'remember') && (
        <div className="tool-foot small knowledge-saved">
          <span className="ellipsis">{shown}</span>
          <button className="link" onClick={() => openNote(notePath)}>{t('toolcard.openNote')}</button>
        </div>
      )}

      {approval && (
        <div className={`approval${approval.flagged ? ' flagged' : ''}`}>
          <div>
            {approval.flagged ? (
              <>
                <strong>{t('toolcard.flagged')}</strong>
                {reviewerReasonShown(approval) && <div className="small">{reviewerReasonShown(approval)}</div>}
              </>
            ) : (
              <>
                <strong>{t('toolcard.allowQuestion')}</strong>
                {reviewerReasonShown(approval) && <div className="small muted">{reviewerReasonShown(approval)}</div>}
              </>
            )}
          </div>
          {approval.preview?.company ? (
            <CompanyProposalCard proposal={approval.preview.company} />
          ) : approval.preview ? (
            <PostPreview
              image={approval.preview.imageDataUrl ? <img className="post-image" src={approval.preview.imageDataUrl} alt={t('toolcard.postImage')} /> : undefined}
              caption={approval.preview.caption}
              note={approval.preview.note}
            />
          ) : (
            !expanded && <InputDetails name={use.name} input={use.input} threadId={thread.id} />
          )}
          <div className="row">
            <button className="primary small" onClick={() => respond('allow')}>
              {use.name === 'instagram_publish' ? t('toolcard.publish') : t('toolcard.allow')}
            </button>
            {approval.allowAlways && !approval.preview?.company && (
              <button className="ghost small" onClick={() => respond('always')} title={t('toolcard.alwaysTitle', { tool: toolLabel(use.name, t) })}>
                {t('toolcard.always')}
              </button>
            )}
            <button className="danger small" onClick={() => respond('deny')}>
              {t('toolcard.deny')}
            </button>
          </div>
        </div>
      )}

      {expanded && (
        <div className="tool-body">
          {isDelegate && run ? (
            <>
              <div className="detail-label">{t('toolcard.task')}</div>
              <div className="subagent-task">{run.task}</div>
              <div className="detail-label">{t('toolcard.subagentWork')}</div>
              <div className="subagent-transcript">
                <MessageList
                  thread={thread}
                  messages={run.messages.slice(1)}
                  draft={drafts[`${thread.id}:${run.id}`]}
                  drafts={drafts}
                  approvals={approvals}
                  running={run.status === 'running'}
                />
              </div>
            </>
          ) : (
            <InputDetails name={use.name} input={use.input} threadId={thread.id} />
          )}
          {result && (
            <>
              <div className="detail-label">{result.is_error ? t('toolcard.status.error') : t('toolcard.result')}</div>
              <pre className={`code output${result.is_error ? ' error' : ''}`}>{shown}</pre>
            </>
          )}
        </div>
      )}

      {state?.note && !approval && (
        <div className="tool-foot muted small">
          {statusText(state.status, t)} · {state.note}
        </div>
      )}
      {isDelegate && run?.status === 'running' && !expanded && <SubagentPeek draft={drafts[`${thread.id}:${run.id}`]} />}
    </div>
  )
}

/** Live one-liner under a collapsed subagent card, so parallel agents are visible at a glance. */
function SubagentPeek({ draft }: { draft?: Draft }): React.JSX.Element {
  const t = useT()
  const lastTool = draft?.tools[draft.tools.length - 1]
  const text = draft?.text.trim().split('\n').pop()
  return (
    <div className="tool-foot muted small ellipsis">
      <span className="spinner" /> {lastTool ? toolLabel(lastTool.name, t) : text || t('toolcard.working')}
    </div>
  )
}
