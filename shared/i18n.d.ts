/** i18n.d.ts - types for shared/i18n.js (the translator the page and server share). */

export interface CatalogMeta {
  name: string
  englishName: string
  translators?: string[]
  status?: 'wip'
}

export interface Catalog {
  meta: CatalogMeta
  ui?: Record<string, unknown>
  chatter?: Record<string, unknown>
  server?: Record<string, unknown>
}

export type Vars = Record<string, string | number>

export interface Translator {
  lang: string
  t(key: string, vars?: Vars): string
  list(key: string): string[]
}

export function flatten(node: object, prefix?: string, out?: Record<string, string | string[]>): Record<string, string | string[]>
export function matchLocale(requested: string | null | undefined, available: string[]): string
export function createTranslator(catalogs: Record<string, Catalog | object>, lang: string): Translator
export function isTranslated(mine: Record<string, string | string[]>, key: string): boolean
export function completeness(catalog: object, en: object): number
export function formatMoney(usd: number, lang: string): string
export function formatNumber(n: number, lang: string): string
export function formatTime(ms: number, lang: string): string
export function formatDate(ms: number, lang: string): string
