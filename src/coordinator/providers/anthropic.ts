import Anthropic from '@anthropic-ai/sdk'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import * as z from 'zod/v4'
import type { Block, ChatMessage } from '../../shared/types'
import { ProviderConfigError, type Provider, type ReviewVerdict, type StopReason, type TurnRequest, type TurnResult } from './types'

/** Models that accept the server-side refusal fallback in its `"default"` form. */
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-fable-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'])
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'
const MISSING_KEY = 'Falta la API key de Anthropic. Cargala en Configuración → Proveedores o definí ANTHROPIC_API_KEY.'

const ReviewSchema = z.object({
  verdict: z.enum(['allow', 'flag']),
  reason: z.string()
})

/** Adaptive thinking and `output_config.effort` exist on the 4.6+ and 5.x families. */
function supportsAdaptiveThinking(model: string): boolean {
  return /^claude-(opus|sonnet|haiku|fable|mythos)-(5|4-[6-9])/.test(model)
}

export function toAnthropicMessages(messages: ChatMessage[]): Anthropic.Beta.BetaMessageParam[] {
  const out: Anthropic.Beta.BetaMessageParam[] = []
  for (const message of messages) {
    // Replay Claude's own content unchanged: thinking blocks must come back exactly as returned.
    if (message.role === 'assistant' && message.provider === 'anthropic' && Array.isArray(message.raw)) {
      out.push({ role: 'assistant', content: message.raw as Anthropic.Beta.BetaContentBlockParam[] })
      continue
    }
    const content: Anthropic.Beta.BetaContentBlockParam[] = []
    for (const block of message.content) {
      if (block.type === 'text' && block.text) content.push({ type: 'text', text: block.text })
      else if (block.type === 'image') {
        content.push({ type: 'image', source: { type: 'base64', media_type: block.mediaType as 'image/jpeg', data: block.data } })
      } else if (block.type === 'tool_use') {
        content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {} })
      } else if (block.type === 'tool_result') {
        content.push({
          type: 'tool_result',
          tool_use_id: block.tool_use_id,
          content: block.content,
          ...(block.is_error ? { is_error: true } : {})
        })
      }
      // Thinking from another provider has no signature and is dropped.
    }
    if (content.length > 0) out.push({ role: message.role, content })
  }
  return out
}

function toBlocks(content: Anthropic.Beta.BetaContentBlock[]): Block[] {
  const blocks: Block[] = []
  for (const block of content) {
    if (block.type === 'text') blocks.push({ type: 'text', text: block.text })
    else if (block.type === 'thinking' && block.thinking) blocks.push({ type: 'thinking', thinking: block.thinking })
    else if (block.type === 'tool_use') blocks.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input })
  }
  return blocks
}

function mapStopReason(reason: string | null): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn'
    case 'tool_use':
      return 'tool_use'
    case 'max_tokens':
      return 'max_tokens'
    case 'refusal':
      return 'refusal'
    default:
      return 'other'
  }
}

export class AnthropicProvider implements Provider {
  readonly id = 'anthropic' as const
  private client: Anthropic

  constructor(apiKey: string) {
    // Without a stored key the SDK resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile.
    const env = process.env
    const hasProfile = !!env.ANTHROPIC_PROFILE || existsSync(join(homedir(), '.config', 'anthropic'))
    if (!apiKey && !env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN && !hasProfile) {
      throw new ProviderConfigError(MISSING_KEY)
    }
    try {
      this.client = apiKey ? new Anthropic({ apiKey }) : new Anthropic()
    } catch {
      throw new ProviderConfigError(MISSING_KEY)
    }
  }

  async streamTurn(request: TurnRequest): Promise<TurnResult> {
    const { model } = request
    const adaptive = supportsAdaptiveThinking(model)
    const params: Anthropic.Beta.MessageCreateParamsStreaming = {
      model,
      max_tokens: 64000,
      stream: true,
      system: [{ type: 'text', text: request.system }],
      messages: toAnthropicMessages(request.messages),
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
        eager_input_streaming: true
      })),
      // Automatic prompt caching: the growing conversation prefix is reused across agent-loop turns.
      cache_control: { type: 'ephemeral' },
      ...(adaptive
        ? { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: request.effort } }
        : {}),
      ...(FALLBACK_MODELS.has(model) ? { betas: [FALLBACK_BETA], fallbacks: 'default' } : {})
    }

    // With eager input streaming a tool input that isn't valid JSON rejects the stream; re-issue that turn.
    for (let attempt = 0; ; attempt++) {
      try {
        const stream = this.client.beta.messages.stream(params, { signal: request.signal })
        for await (const event of stream) {
          if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
            request.onToolStart(event.content_block.id, event.content_block.name)
          } else if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta') request.onText(event.delta.text)
            else if (event.delta.type === 'thinking_delta') request.onThinking(event.delta.thinking)
          }
        }
        const message = await stream.finalMessage()
        const usage = message.usage
        return {
          content: toBlocks(message.content),
          raw: message.content,
          stopReason: mapStopReason(message.stop_reason),
          stopDetail:
            message.stop_reason === 'refusal'
              ? (message.stop_details?.explanation ?? message.stop_details?.category ?? undefined) || undefined
              : undefined,
          usage: {
            inputTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
            outputTokens: usage.output_tokens,
            cacheReadTokens: usage.cache_read_input_tokens ?? 0
          },
          model: message.model
        }
      } catch (error) {
        if (error instanceof Anthropic.AuthenticationError) {
          throw new ProviderConfigError('Anthropic rechazó la API key. Revisala en Configuración → Proveedores.')
        }
        if (error instanceof Anthropic.APIError || request.signal.aborted || attempt >= 2) throw error
      }
    }
  }

  async review(request: { model: string; system: string; prompt: string; signal: AbortSignal }): Promise<ReviewVerdict> {
    const response = await this.client.messages.parse(
      {
        model: request.model,
        max_tokens: 4096,
        system: request.system,
        messages: [{ role: 'user', content: request.prompt }],
        output_config: {
          format: zodOutputFormat(ReviewSchema),
          ...(supportsAdaptiveThinking(request.model) ? { effort: 'low' as const } : {})
        }
      },
      { signal: request.signal }
    )
    if (response.stop_reason === 'refusal' || !response.parsed_output) {
      return { verdict: 'flag', reason: 'El revisor no pudo evaluar esta acción.' }
    }
    return response.parsed_output
  }

  async listModels(): Promise<string[]> {
    const ids: string[] = []
    for await (const model of this.client.models.list()) ids.push(model.id)
    return ids
  }
}
