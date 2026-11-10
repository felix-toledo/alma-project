/** The size a request announces, when it announces a plain count of bytes. */
export const declaredBytes = (header: string | null): number | undefined => (header !== null && /^\d{1,15}$/.test(header) ? Number(header) : undefined)

/**
 * Reads a phone's request body up to `max` bytes. Past the cap the rest is not read and the stream is cancelled;
 * the count says it is over and the room refuses it as full. A body that is not JSON has no `raw`, and the room says malformed.
 * `declared` is the size the request announced, believed only when it is over the cap.
 */
export async function readFrameBody(body: ReadableStream<Uint8Array> | null, max: number, declared?: number): Promise<{ raw: unknown; bytes: number }> {
  if (declared !== undefined && declared > max) {
    await body?.cancel()
    return { raw: undefined, bytes: declared }
  }
  if (!body) return { raw: undefined, bytes: 0 }
  const chunks: Uint8Array[] = []
  let bytes = 0
  const reader = body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.length
    if (bytes > max) {
      await reader.cancel()
      return { raw: undefined, bytes }
    }
    chunks.push(value)
  }
  const whole = new Uint8Array(bytes)
  let at = 0
  for (const chunk of chunks) {
    whole.set(chunk, at)
    at += chunk.length
  }
  try {
    return { raw: JSON.parse(new TextDecoder().decode(whole)), bytes }
  } catch {
    return { raw: undefined, bytes }
  }
}
