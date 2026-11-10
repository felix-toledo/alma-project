import { describe, expect, it } from 'vitest'
import { isSecretLikeName, maskSecrets } from '../src/shared/attach/secrets'

describe('secret-looking names', () => {
  it('AC-3.2 (030) secret-looking names', () => {
    const flagged = [
      '.env', '.env.local', '.env.production', '.npmrc', '.netrc',
      'server.pem', 'tls.key', 'cert.pfx', 'putty.ppk', 'vault.kdbx',
      'id_rsa', 'id_rsa.pub', 'id_ed25519', 'id_ed25519.pub',
      'passwords.xlsx', 'passwords.txt', 'credentials.json', 'credentials', 'credentials-prod.csv',
      'Login Data', 'Cookies',
    ]
    for (const name of flagged) expect(isSecretLikeName(name), name).toBe(true)
    // case does not matter
    for (const name of ['.ENV', 'SERVER.PEM', 'Id_Rsa', 'PASSWORDS.XLSX', 'login data', 'COOKIES', 'Credentials.JSON']) {
      expect(isSecretLikeName(name), name).toBe(true)
    }
  })

  it('AC-3.2 (030) near misses are not flagged', () => {
    for (const name of ['environment.txt', 'keyboard.md', 'cookies-recipe.md', 'monkey', 'passwords', 'notes.txt', 'report.pdf', 'my-env.txt', 'pem.txt', 'rsa.txt', 'Login.txt', 'photo.png']) {
      expect(isSecretLikeName(name), name).toBe(false)
    }
    expect(isSecretLikeName('')).toBe(false)
  })

  it('AC-3.2 (030) a path whose file name or folder segment matches is flagged (G13)', () => {
    expect(isSecretLikeName('notes.txt', 'C:\\Users\\me\\.env\\notes.txt')).toBe(true)
    expect(isSecretLikeName('notes.txt', '/home/me/credentials/notes.txt')).toBe(true)
    expect(isSecretLikeName('notes.txt', 'C:\\Users\\me\\Documents\\notes.txt')).toBe(false)
    expect(isSecretLikeName('renamed.txt', 'C:\\keys\\id_rsa')).toBe(true)
    // a name that carries separators is judged by its segments too
    expect(isSecretLikeName('a/.env')).toBe(true)
    // only whole segments count: a folder merely containing the word is fine
    expect(isSecretLikeName('a.txt', 'C:\\work\\environment\\a.txt')).toBe(false)
  })
})

// Every value below is built from a visible placeholder: none is a real credential.
const fake = (prefix: string, length: number, filler = 'X') => prefix + filler.repeat(length)

describe('masking', () => {
  it('AC-3.5 (030) masks values and counts them', () => {
    const cases: [string, string][] = [
      ['xai key', `key ${fake('xai-', 24)} end`],
      ['sk key', `key ${fake('sk-', 24)} end`],
      ['LLM key', `key ${fake('LLM-', 24)} end`],
      ['bearer', `Authorization: ${fake('Bearer ', 24)}`],
      ['password', 'password = hunter2'],
      ['passwd colon', 'passwd: hunter2'],
      ['token', 'token=abc123'],
      ['secret', 'SECRET : abc123'],
      ['api_key', 'api_key=abc123'],
      ['api-key', 'API-KEY=abc123'],
      ['aws akia', `id ${fake('AKIA', 16)}`],
      ['aws asia', `id ${fake('ASIA', 16)}`],
      ['github ghp', `t ${fake('ghp_', 36)}`],
      ['github gho', `t ${fake('gho_', 36)}`],
      ['github ghu', `t ${fake('ghu_', 36)}`],
      ['github ghs', `t ${fake('ghs_', 36)}`],
      ['github ghr', `t ${fake('ghr_', 36)}`],
      ['github pat', `t ${fake('github_pat_', 30)}`],
      ['google', `k ${fake('AIza', 35)}`],
      ['slack bot', `t ${fake('xoxb-', 20)}`],
      ['slack user', `t ${fake('xoxp-', 20)}`],
    ]
    for (const [label, input] of cases) {
      const out = maskSecrets(input)
      expect(out.masked, label).toBe(1)
      expect(out.text, label).toContain('[masked]')
      expect(out.text, label).not.toMatch(/XXXXXXXX|hunter2|abc123/)
    }
  })

  it('AC-3.5 (030) masks a private key block, multi-line or cut short', () => {
    const body = 'FAKEFAKEFAKEFAKEFAKE\nFAKEFAKEFAKEFAKEFAKE'
    const block = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`
    expect(maskSecrets(`before\n${block}\nafter`)).toEqual({ text: 'before\n[masked]\nafter', masked: 1 })
    expect(maskSecrets(`-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`).masked).toBe(1)
    expect(maskSecrets(`-----BEGIN OPENSSH PRIVATE KEY-----\n${body}`)).toEqual({ text: '[masked]', masked: 1 })
    // a public key is not a secret
    const pub = '-----BEGIN PUBLIC KEY-----\nFAKE\n-----END PUBLIC KEY-----'
    expect(maskSecrets(pub)).toEqual({ text: pub, masked: 0 })
  })

  it('AC-3.5 (030) no secret in the text leaves the text and a zero', () => {
    const plain = 'Meeting notes: the token economy and a secret santa. Keys are on the table.'
    expect(maskSecrets(plain)).toEqual({ text: plain, masked: 0 })
    expect(maskSecrets('')).toEqual({ text: '', masked: 0 })
  })

  it('AC-3.5 (030) adjacent and repeated values are all masked and counted once each', () => {
    const a = fake('sk-', 24)
    const b = fake('AKIA', 16)
    expect(maskSecrets(`${a} ${b}`)).toEqual({ text: '[masked] [masked]', masked: 2 })
    expect(maskSecrets(`${a}\n${a}\n${a}`).masked).toBe(3)
    // one value matched by two families is one value
    expect(maskSecrets(`password=${a}`)).toEqual({ text: 'password=[masked]', masked: 1 })
  })

  it('AC-3.5 (030) keeps the label of a key=value pair and the rest of the text', () => {
    expect(maskSecrets('host=db1 password=hunter2 port=5432').text).toBe('host=db1 password=[masked] port=5432')
    expect(maskSecrets(`Authorization: ${fake('Bearer ', 24)} ok`).text).toBe('Authorization: Bearer [masked] ok')
  })

  it('AC-3.5 (030) known limit: a quoted JSON key is not masked (G11)', () => {
    const json = '{"password": "hunter2"}'
    expect(maskSecrets(json)).toEqual({ text: json, masked: 0 })
  })

  it('AC-3.5 (030) very long text is handled in one pass', () => {
    const long = `${'lorem ipsum '.repeat(200_000)}${fake('sk-', 24)}${' x'.repeat(100_000)}`
    const started = Date.now()
    const out = maskSecrets(long)
    expect(out.masked).toBe(1)
    expect(out.text).not.toContain('sk-')
    expect(Date.now() - started).toBeLessThan(2000)
    // many unterminated openers must not make it quadratic
    const many = '-----BEGIN PRIVATE KEY-----\nx\n'.repeat(5000)
    expect(maskSecrets(many).masked).toBe(1)
  })
})
