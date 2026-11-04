// Words too common to search for. Spanish on purpose: it is the vocabulary of the notes' language, not text Alma shows.
export const STOPWORDS = new Set(
  'de la el los las un una unos unas y o u a al del en con por para que como es son se su sus lo le les mi mis tu tus me te nos ya no si sí pero mas más muy este esta estos estas ese esa eso the of and to in is'.split(' ')
)
