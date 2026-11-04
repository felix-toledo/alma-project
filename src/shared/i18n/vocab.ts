// The short phrases a person says to Alma: yes or no to an approval, a closing, a cancel. Spanish and English are
// understood at the same time, whatever the app language is (spec 025 BR-20), because people mix them and the app
// language is not what they happen to say.

/** Lowercase, no accents, no punctuation, single spaces: "¡Sí, dale!" → "si dale". */
function plain(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const NO = [
  // es
  'no|nop|nunca|cancela\\w*|rechaza\\w*|para|frena|negativo|mejor no',
  // en
  'nope|nah|never|cancel\\w*|reject\\w*|deny|stop|halt|negative|better not'
].join('|')
const YES = [
  // es
  'si|dale|ok|okay|claro|bueno|perfecto|adelante|hacelo|permiti\\w*|acepto|afirmativo|de una',
  // en
  'yes|yeah|yep|yup|sure|alright|perfect|go ahead|do it|allow\\w*|accept|affirmative|of course|please do'
].join('|')

// A negation anywhere makes a phrase a refusal or, next to a yes word, unclear: never a yes ("don't do it", "of course not", "not sure").
// `plain` turns "don't" into "don t" and "can't" into "can t".
const NEGATION = "\\b(not|cannot|dont|don t|doesn t|didn t|can t|won t|wouldn t|shouldn t|isn t|aren t|never)\\b"
const NO_WORDS = new RegExp(`\\b(${NO})\\b|${NEGATION}`)
const YES_WORDS = new RegExp(`\\b(${YES})\\b`)

/** "Sí, dale" / "yeah, go ahead" → yes; "no, cancelá" / "nope" → no; a phrase with both kinds, or neither → null (ask again). When in doubt it is never yes. */
export function parseYesNo(text: string): 'yes' | 'no' | null {
  const t = plain(text)
  const no = NO_WORDS.test(t)
  const yes = YES_WORDS.test(t)
  if (no && !yes) return 'no'
  if (yes && !no) return 'yes'
  return null
}

const CLOSING = [
  // es
  'gracias|muchas gracias|listo|nada|nada mas|chau|chao|adios|eso es todo|eso era todo|ya esta|esta bien|ok|okey|perfecto|genial|buenisimo|joya|de nada|hasta luego|nos vemos',
  // en (apostrophes are dropped by `plain`, so "that's" is "that s")
  'thanks|thank you|thanks a lot|thank you very much|done|nothing|nothing else|bye|goodbye|that is all|that is it|that s all|that s it|all good|it is fine|okay|perfect|great|awesome|cool|nice|you are welcome|see you|see you later|no problem'
].join('|')
const GOODBYE = new RegExp(`^(no )?(${CLOSING})( (${CLOSING}|alma))*$`)

/** "Gracias", "listo, nada más", "thanks, that's all", "chau": the person is closing the conversation, not asking something new. */
export function isGoodbye(text: string): boolean {
  return GOODBYE.test(plain(text))
}

const CANCEL = 'cancel|cancela\\w*|cancelar|stop|para|frena|olvidalo|olvidala|dejalo|never mind|nevermind|forget it|leave it'
const CANCEL_PHRASE = new RegExp(`^(no )?(${CANCEL})( (alma|please|por favor))*$`)

/** A spoken cancel: the whole phrase is the cancel ("cancelá", "never mind"), not a request that mentions one. */
export function isCancel(text: string): boolean {
  return CANCEL_PHRASE.test(plain(text))
}
