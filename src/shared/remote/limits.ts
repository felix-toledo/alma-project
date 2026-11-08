/** The limits of spec 026 BR-31 (applied unchanged to spec 028). Zod-free so the PWA can import it without the schema code. */
export const REMOTE_LIMITS = {
  requestBytes: 1_048_576,
  photoBytes: 2_097_152,
  chatChars: 8000,
  requestsPerMinute: 60,
  connectionsPerDevice: 2,
  timeoutMs: 30_000,
  testWaitMs: 10_000,
  pairingPerMinute: 5,
  approvalInputChars: 1500,
  longPollMs: 25_000,
  firstLoadMessages: 30
} as const
