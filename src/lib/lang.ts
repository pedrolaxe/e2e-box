// Idioma do painel: compartilhado entre o servidor (layout lê o cookie) e o cliente (i18n.tsx).

export type Lang = 'pt-BR' | 'en'
export const LANGS: { id: Lang; short: string; name: string }[] = [
  { id: 'pt-BR', short: 'PT', name: 'Português (Brasil)' },
  { id: 'en', short: 'EN', name: 'English' },
]
export const LANG_COOKIE = 'e2e-box-lang'

/** Escolha salva no cookie; sem ela, o idioma principal do navegador (português → pt-BR, outro → en). */
export function pickLang(cookie: string | undefined, acceptLanguage: string | null): Lang {
  if (cookie === 'pt-BR' || cookie === 'en') return cookie
  if (!acceptLanguage) return 'pt-BR'
  return /^\s*pt\b/i.test(acceptLanguage) ? 'pt-BR' : 'en'
}
