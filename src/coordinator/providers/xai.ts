// Grok through xAI's public, OpenAI-compatible API (https://api.x.ai/v1), and DeepSeek through its own
// OpenAI-compatible API (https://api.deepseek.com), the Vercel AI Gateway (https://ai-gateway.vercel.sh/v1) and
// Meta's Muse models (https://api.meta.ai/v1).
import OpenAI from 'openai'
import * as z from 'zod/v4'
import type { Language } from '../../shared/i18n/language'
import { translate } from '../../shared/i18n/messages'
import type { Block, ChatMessage, ProviderId } from '../../shared/types'
import { ProviderConfigError, type Provider, type ReviewVerdict, type StopReason, type TurnRequest, type TurnResult } from './types'

type ChatParam = OpenAI.Chat.ChatCompletionMessageParam

const ReviewSchema = z.object({ verdict: z.enum(['allow', 'flag']), reason: z.string() })
const JSON_ONLY = '\nAnswer only with a JSON object: {"verdict": "allow" | "flag", "reason": "<why>"}.'

/**
 * `replayReasoning`: DeepSeek's thinking mode with tools rejects (400) any later request that doesn't carry its
 * earlier reasoning back as `reasoning_content`, so that provider's own thinking blocks are replayed.
 */
export function toOpenAiMessages(system: string, messages: ChatMessage[], replayReasoning?: ProviderId): ChatParam[] {
  const out: ChatParam[] = [{ role: 'system', content: system }]
  for (const message of messages) {
    const text = message.content
      .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
    if (message.role === 'user') {
      // Tool results must directly follow the assistant message that requested them.
      for (const block of message.content) {
        if (block.type === 'tool_result') {
          out.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: block.is_error ? `ERROR: ${block.content}` : block.content
          })
        }
      }
      const images = message.content.filter((b): b is Extract<Block, { type: 'image' }> => b.type === 'image')
      if (images.length) {
        out.push({
          role: 'user',
          content: [
            ...(text ? [{ type: 'text' as const, text }] : []),
            ...images.map((image) => ({ type: 'image_url' as const, image_url: { url: `data:${image.mediaType};base64,${image.data}` } }))
          ]
        })
      } else if (text) out.push({ role: 'user', content: text })
      continue
    }
    const toolCalls = message.content
      .filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use')
      .map((b) => ({
        id: b.id,
        type: 'function' as const,
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) }
      }))
    if (!text && toolCalls.length === 0) continue
    const reasoning =
      replayReasoning && message.provider === replayReasoning
        ? message.content
            .filter((b): b is Extract<Block, { type: 'thinking' }> => b.type === 'thinking')
            .map((b) => b.thinking)
            .join('')
        : ''
    out.push({
      role: 'assistant',
      content: text || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      ...(reasoning ? { reasoning_content: reasoning } : {})
    } as ChatParam)
  }
  return out
}

function mapFinishReason(reason: string | null, hasToolCalls: boolean): StopReason {
  if (reason === 'tool_calls' || (hasToolCalls && reason === 'stop')) return 'tool_use'
  if (reason === 'stop') return 'end_turn'
  if (reason === 'length') return 'max_tokens'
  if (reason === 'content_filter') return 'refusal'
  return hasToolCalls ? 'tool_use' : 'other'
}

// Models that don't take chat completions with our tools. The multi-agent model only runs through the Responses API.
const NOT_CHAT_MODEL = /image|imagine|vision|video|embed|voice|tts|stt|realtime|multi-agent/

/** Picks the newest general Grok chat model when the agent profile leaves the model empty. */
export function pickDefaultGrokModel(ids: string[]): string | undefined {
  // xAI versions are decimals: grok-4.20 came before grok-4.3.
  const version = (id: string): number => Number(/^grok-(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? NaN)
  return (
    ids
      .filter((id) => !Number.isNaN(version(id)) && !NOT_CHAT_MODEL.test(id))
      // Among variants of one version, the plain id is the flagship.
      .sort((a, b) => version(b) - version(a) || a.length - b.length || a.localeCompare(b))[0]
  )
}

/** Best human-readable reason in an error body, whatever its shape. */
export function errorMessageOf(body: string): string {
  let data: Record<string, unknown> | null
  try {
    data = JSON.parse(body) as Record<string, unknown> | null
  } catch {
    return body.trim()
  }
  const nested = data?.error
  const text = [
    nested && typeof nested === 'object' ? (nested as { message?: unknown }).message : nested,
    data?.message,
    data?.detail
  ].find((value): value is string => typeof value === 'string' && value.trim() !== '')
  const code = typeof data?.code === 'string' ? data.code : undefined
  if (text) return code && !text.includes(code) ? `${text} (${code})` : text
  return code ?? body.trim()
}

/**
 * xAI's error bodies aren't shaped like OpenAI's ({ error: { message } }), so the SDK drops the reason and
 * reports "400 status code (no body)". This rewraps them so the reason reaches the user.
 */
export const readableErrorsFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init)
  if (response.ok) return response
  const message = errorMessageOf(await response.text())
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.delete('content-encoding')
  headers.set('content-type', 'application/json')
  return new Response(JSON.stringify({ error: { message } }), {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

/** What differs between the OpenAI-compatible APIs this provider talks to. */
interface Flavor {
  id: Extract<ProviderId, 'xai' | 'deepseek' | 'vercel' | 'meta'>
  name: string
  envVar: string
  pickDefaultModel(ids: string[]): string | undefined
}

const XAI: Flavor = { id: 'xai', name: 'xAI', envVar: 'XAI_API_KEY', pickDefaultModel: pickDefaultGrokModel }

export const DEEPSEEK: Flavor = {
  id: 'deepseek',
  name: 'DeepSeek',
  envVar: 'DEEPSEEK_API_KEY',
  // V4 Pro is the flagship for agent work; deepseek-flash is cheaper and also takes images.
  pickDefaultModel: (ids) => (ids.includes('deepseek-v4-pro') ? 'deepseek-v4-pro' : ids[0])
}

export const VERCEL: Flavor = {
  id: 'vercel',
  name: 'Vercel AI Gateway',
  envVar: 'AI_GATEWAY_API_KEY',
  // Ids are `lab/model`; Sonnet is a good all-round default for agent work.
  pickDefaultModel: (ids) => ids.find((id) => id.startsWith('anthropic/claude-sonnet')) ?? ids[0]
}

export const META: Flavor = {
  id: 'meta',
  name: 'Meta',
  envVar: 'META_API_KEY',
  // /models also lists Muse Image, Voice Transcribe and SAM, which don't chat.
  pickDefaultModel: (ids) => (ids.includes('muse-spark-1.3') ? 'muse-spark-1.3' : ids.find((id) => id.startsWith('muse-spark')))
}

export class XaiProvider implements Provider {
  readonly id: Flavor['id']
  private client: OpenAI
  private defaultModel?: Promise<string>

  constructor(
    apiKey: string,
    baseUrl: string,
    private readonly flavor: Flavor = XAI,
    private readonly language: Language = 'es'
  ) {
    this.id = flavor.id
    const key = apiKey || process.env[flavor.envVar]
    if (!key) {
      throw new ProviderConfigError(translate(language, 'provider.missingKey', { name: flavor.name, envVar: flavor.envVar }))
    }
    this.client = new OpenAI({ apiKey: key, baseURL: baseUrl, fetch: readableErrorsFetch })
  }

  private async resolveModel(model: string): Promise<string> {
    if (model) return model
    this.defaultModel ??= this.listModels().then((ids) => {
      const picked = this.flavor.pickDefaultModel(ids)
      if (!picked) throw new ProviderConfigError(translate(this.language, 'provider.noModel', { name: this.flavor.name }))
      return picked
    })
    return this.defaultModel
  }

  async streamTurn(request: TurnRequest): Promise<TurnResult> {
    const model = await this.resolveModel(request.model)
    const stream = await this.client.chat.completions
      .create(
      {
        model,
        messages: toOpenAiMessages(request.system, request.messages, this.id === 'deepseek' ? 'deepseek' : undefined),
        // DeepSeek maps every effort level (low…max) onto its own; xAI's chat models don't take one.
        ...(this.id === 'deepseek' ? { reasoning_effort: request.effort } : {}),
        ...(request.tools.length
          ? {
              tools: request.tools.map((tool) => ({
                type: 'function' as const,
                function: { name: tool.name, description: tool.description, parameters: tool.inputSchema }
              }))
            }
          : {}),
        stream: true,
        stream_options: { include_usage: true }
      },
      { signal: request.signal }
      )
      .catch((error: unknown) => {
        if (error instanceof OpenAI.AuthenticationError) {
          throw new ProviderConfigError(translate(this.language, 'provider.rejected', { name: this.flavor.name }))
        }
        throw error
      })

    let text = ''
    let thinking = ''
    let finishReason: string | null = null
    let usage: TurnResult['usage']
    const calls: { id: string; name: string; args: string; announced: boolean }[] = []

    for await (const chunk of stream) {
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
          cacheReadTokens:
            chunk.usage.prompt_tokens_details?.cached_tokens ??
            (chunk.usage as { prompt_cache_hit_tokens?: number }).prompt_cache_hit_tokens ??
            0
        }
      }
      const choice = chunk.choices[0]
      if (!choice) continue
      // Grok and DeepSeek reasoning models stream their reasoning separately from the answer.
      const delta = choice.delta as typeof choice.delta & { reasoning_content?: string }
      if (delta.reasoning_content) {
        thinking += delta.reasoning_content
        request.onThinking(delta.reasoning_content)
      }
      if (delta.content) {
        text += delta.content
        request.onText(delta.content)
      }
      for (const call of delta.tool_calls ?? []) {
        const slot = (calls[call.index] ??= { id: '', name: '', args: '', announced: false })
        if (call.id) slot.id = call.id
        if (call.function?.name) slot.name = call.function.name
        if (call.function?.arguments) slot.args += call.function.arguments
        if (!slot.announced && slot.id && slot.name) {
          slot.announced = true
          request.onToolStart(slot.id, slot.name)
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason
    }

    const content: Block[] = []
    if (thinking) content.push({ type: 'thinking', thinking })
    if (text) content.push({ type: 'text', text })
    for (const call of calls.filter(Boolean)) {
      let input: unknown
      try {
        input = JSON.parse(call.args || '{}')
      } catch {
        // Schema validation rejects this and the model gets an INVALID_JSON error result.
        input = { __invalid_json: call.args }
      }
      content.push({ type: 'tool_use', id: call.id || `call_${crypto.randomUUID()}`, name: call.name, input })
    }
    return {
      content,
      stopReason: mapFinishReason(finishReason, calls.length > 0),
      stopDetail: finishReason === 'content_filter' ? translate(this.language, 'provider.filtered', { name: this.flavor.name }) : undefined,
      usage,
      model
    }
  }

  async review(request: { model: string; system: string; prompt: string; signal: AbortSignal }): Promise<ReviewVerdict> {
    const response = await this.client.chat.completions.create(
      {
        model: await this.resolveModel(request.model),
        messages: [
          { role: 'system', content: request.system + (this.id === 'xai' ? '' : JSON_ONLY) },
          { role: 'user', content: request.prompt }
        ],
        // DeepSeek only takes plain JSON mode, which needs the shape spelled out in the prompt.
        // The gateway fronts many labs, not all with JSON mode, and Meta's structured output isn't verified here,
        // so both rely on the prompt alone.
        ...(this.id === 'vercel' || this.id === 'meta'
          ? {}
          : {
              response_format:
                this.id === 'deepseek'
                  ? { type: 'json_object' as const }
                  : {
                      type: 'json_schema' as const,
                      json_schema: { name: 'review', strict: true, schema: z.toJSONSchema(ReviewSchema) as Record<string, unknown> }
                    }
            })
      },
      { signal: request.signal }
    )
    try {
      const raw = response.choices[0]?.message.content ?? ''
      return ReviewSchema.parse(JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)))
    } catch {
      return { verdict: 'flag', reason: 'The reviewer did not return a valid verdict.' }
    }
  }

  async listModels(): Promise<string[]> {
    const ids: string[] = []
    for await (const model of this.client.models.list()) ids.push(model.id)
    return ids
  }
}
