// dsh-email in-package skill (registerProvider; SKILL.md is the single source of
// usage details; the prompt side keeps only a one-line pointer).
// The file carries YAML frontmatter (the de facto standard for SKILL.md files);
// its fields are the skill metadata, parsed with a contract isomorphic to the
// framework's dsh-skill-filesystem convention: `name` required and must equal
// the provider name; `description` required non-empty; `whenToUse` optional;
// `disable-model-invocation` / `user-invocable` optional booleans (defaults:
// both surfaces open); unknown fields ignored; legacy camelCase invocation keys
// (disableModelInvocation / modelInvocable / userInvocable) rejected, exactly
// as the filesystem convention does. Parsing runs synchronously at registration
// (fail-fast): the file is a shipped static artifact, so a malformed frontmatter
// fails plugin apply and is caught by the build gates rather than degrading
// silently at runtime. `get()` returns the body with the frontmatter stripped,
// so injected content never leaks metadata into the prompt.
// rank uses the framework's BUNDLED_SKILL_RANK (the standard priority for
// packaged skills; on name collisions the lower rank wins); the name is unique
// here, the value only aligns with convention.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { BUNDLED_SKILL_RANK, type SkillCandidate } from '@deepseek-ai/dsh-skill'
import { PLUGIN_NAME, isPlainObject, packageRoot } from './util.js'
import type { Context } from './types.js'

// SKILL.md sits under the package root (src development state / lib deployment state are isomorphic).
const SKILL_PATH = path.join(packageRoot(), 'skill', PLUGIN_NAME, 'SKILL.md')

function requireNonEmptyString(data: Record<string, unknown>, key: string): string {
  const value = data[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${PLUGIN_NAME} skill frontmatter field "${key}" must be a non-empty string`)
  }
  return value
}

function rejectLegacyInvocationKeys(data: Record<string, unknown>): void {
  const legacyKeys: Array<[string, string]> = [
    ['disableModelInvocation', 'disable-model-invocation'],
    ['modelInvocable', 'disable-model-invocation'],
    ['userInvocable', 'user-invocable'],
  ]
  for (const [legacy, canonical] of legacyKeys) {
    if (Object.hasOwn(data, legacy)) {
      throw new Error(`${PLUGIN_NAME} skill frontmatter field "${legacy}" is unsupported; use "${canonical}"`)
    }
  }
}

function frontmatterBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') switch (value.toLowerCase()) {
    case 'true':
    case 'yes':
    case 'on': return true
    case 'false':
    case 'no':
    case 'off': return false
  }
  throw new TypeError(`${PLUGIN_NAME} skill frontmatter field "${key}" must be a boolean`)
}

function parseSkillFile(raw: string): { data: Record<string, unknown>; body: string } {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0 || raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') {
    throw new Error(`${PLUGIN_NAME} skill file ${SKILL_PATH} is missing YAML frontmatter (first line must be "---")`)
  }
  let lineStart = firstLineEnd + 1
  let closing = -1
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') { closing = lineStart; break }
    if (nextNewline < 0) break
    lineStart = nextNewline + 1
  }
  if (closing < 0) throw new Error(`${PLUGIN_NAME} skill file ${SKILL_PATH} has an unclosed YAML frontmatter block`)
  const parsed = parseYaml(raw.slice(firstLineEnd + 1, closing))
  if (!isPlainObject(parsed)) {
    throw new Error(`${PLUGIN_NAME} skill frontmatter must be a YAML mapping`)
  }
  const bodyStart = raw.indexOf('\n', closing)
  return { data: parsed as Record<string, unknown>, body: raw.slice(bodyStart < 0 ? raw.length : bodyStart + 1) }
}

/**
 * Register the in-package skill provider (the SKILL.md usage guide).
 * @param ctx cordis Context (the host must have loaded the dsh-skill service).
 * @returns framework effect disposer (unregisters the provider when the fiber is unloaded).
 */
export function registerSkill(ctx: Context): () => void {
  const { data, body } = parseSkillFile(readFileSync(SKILL_PATH, 'utf8'))
  if (data.name !== PLUGIN_NAME) {
    throw new Error(`${PLUGIN_NAME} skill frontmatter name "${String(data.name)}" does not match provider name "${PLUGIN_NAME}"`)
  }
  const description = requireNonEmptyString(data, 'description')
  const whenToUse = typeof data.whenToUse === 'string' && data.whenToUse.length > 0 ? data.whenToUse : undefined
  rejectLegacyInvocationKeys(data)
  const disableModelInvocation = frontmatterBoolean(data, 'disable-model-invocation')
  const userInvocable = frontmatterBoolean(data, 'user-invocable')
  const candidate: SkillCandidate = {
    name: PLUGIN_NAME,
    description,
    ...(whenToUse !== undefined ? { whenToUse } : {}),
    invocation: { modelInvocable: disableModelInvocation !== true, userInvocable: userInvocable !== false },
    source: 'bundled',
    provider: PLUGIN_NAME,
    rank: BUNDLED_SKILL_RANK,
    locator: {},
    path: SKILL_PATH,
  }
  return ctx.skills.registerProvider(() => ({
    name: PLUGIN_NAME,
    list: async () => [candidate],
    get: async (cand) => (cand?.name === PLUGIN_NAME ? { ...cand, content: body } : undefined),
  }))
}
