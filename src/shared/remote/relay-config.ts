/**
 * Build-time constants of the relay (spec 027 BR-29, BR-31). The values are facts the maintainer supplied (2026-11-08).
 * The named placeholders stay exported: they are what the publish check and `relayAvailable` compare against.
 */
export const RELAY_DOMAIN_PLACEHOLDER = 'RELAY_DOMAIN_PLACEHOLDER'
export const RELAY_DOMAIN: string = 'almaproject.app'

export const ABUSE_CONTACT_PLACEHOLDER = 'ABUSE_CONTACT_PLACEHOLDER'
export const JURISDICTION_PLACEHOLDER = 'JURISDICTION_PLACEHOLDER'
export const BUDGET_CEILING_PLACEHOLDER = 'BUDGET_CEILING_PLACEHOLDER'
export const ABUSE_CONTACT: string = 'abuse@almaproject.app'
export const JURISDICTION: string = 'Argentina'
export const BUDGET_CEILING: string = 'USD 5 per month'

export interface ReleaseConstants {
  ABUSE_CONTACT: string
  JURISDICTION: string
  BUDGET_CEILING: string
}

/** The constants that still hold their placeholder; publishing the relay is blocked while this is not empty (AC-6.7). */
export function releaseBlockers(constants: ReleaseConstants): string[] {
  const standing: Array<[keyof ReleaseConstants, string]> = [
    ['ABUSE_CONTACT', ABUSE_CONTACT_PLACEHOLDER],
    ['JURISDICTION', JURISDICTION_PLACEHOLDER],
    ['BUDGET_CEILING', BUDGET_CEILING_PLACEHOLDER]
  ]
  return standing.filter(([name, placeholder]) => constants[name] === placeholder).map(([name]) => name)
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** The form `newRoutingId` makes: 26 lower-case base32 characters. */
export const isRoutingId = (value: string): boolean => /^[a-z2-7]{26}$/.test(value)

/**
 * 128 random bits as lower-case base32 without padding: 26 characters, a valid host label that survives the case
 * folding of DNS and certificates (spec 027 PD-15). The last character carries three bits and two zero bits.
 */
export function newRoutingId(random: (length: number) => Uint8Array): string {
  const bytes = random(16)
  let id = ''
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      id += BASE32[(buffer >>> (bits - 5)) & 31]
      bits -= 5
    }
    buffer &= (1 << bits) - 1
  }
  if (bits > 0) id += BASE32[(buffer << (5 - bits)) & 31]
  return id
}

/** A host name: dot-separated labels of letters, digits and inner hyphens, at most 253 characters. */
export function isRelayDomain(value: string): boolean {
  return value.length > 0 && value.length <= 253 && value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
}

/** The build's relay domain, or a development override: the override counts only in an unpackaged app and only as a host name (AC-1.14). */
export function effectiveRelayDomain(input: { build: string; override?: string; packaged: boolean }): string {
  if (input.packaged || input.override === undefined) return input.build
  const override = input.override.toLowerCase()
  return isRelayDomain(override) ? override : input.build
}

/**
 * A packaged app offers the relay only with a real domain and with the abuse contact, jurisdiction and budget ceiling set,
 * so nobody can pick a relay that does not exist or read a notice that still holds a placeholder (AC-6.7).
 * A development run is never held back.
 */
export function relayAvailable(input: { domain: string; packaged: boolean; constants?: ReleaseConstants }): boolean {
  if (!input.packaged) return true
  const constants = input.constants ?? { ABUSE_CONTACT, JURISDICTION, BUDGET_CEILING }
  return input.domain !== '' && input.domain !== RELAY_DOMAIN_PLACEHOLDER && releaseBlockers(constants).length === 0
}
