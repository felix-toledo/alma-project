// The strings of Instagram's own page that the publisher looks for (spec 025 AC-3.8). They are matched against the
// page, never shown. Instagram's interface may be in any of three languages, so all three are always tried; the
// app language goes first, so its words are found before the others are looked at.
import type { Language } from '../shared/i18n/language'

export type InstagramLabel = 'create' | 'post' | 'next' | 'share' | 'dismiss' | 'success'
type PageLanguage = 'en' | 'es' | 'pt'

const LABELS: Record<InstagramLabel, Record<PageLanguage, string[]>> = {
  create: { en: ['New post', 'Create'], es: ['Nueva publicación', 'Crear'], pt: ['Nova publicação', 'Criar'] },
  post: { en: ['Post'], es: ['Publicación', 'Publicar'], pt: ['Publicação'] },
  next: { en: ['Next'], es: ['Siguiente'], pt: ['Avançar'] },
  share: { en: ['Share'], es: ['Compartir'], pt: ['Compartilhar'] },
  dismiss: { en: ['Not Now', 'Not now', 'OK'], es: ['Ahora no'], pt: ['Agora não'] },
  success: {
    en: ['your post has been shared', 'post shared'],
    es: ['se compartió tu publicación', 'se ha compartido tu publicación', 'tu publicación se ha compartido', 'publicación compartida'],
    pt: ['seu post foi compartilhado', 'publicação compartilhada']
  }
}

export function instagramLabels(kind: InstagramLabel, language: Language): string[] {
  const order: PageLanguage[] = language === 'es' ? ['es', 'en', 'pt'] : ['en', 'es', 'pt']
  return [...new Set(order.flatMap((l) => LABELS[kind][l]))]
}
