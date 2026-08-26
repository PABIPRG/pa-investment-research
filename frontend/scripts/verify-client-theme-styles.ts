/** Enforce semantic theme-token use in client packages that have completed strict migration. */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const strictRoots = [
  'packages/client/ui-investment-research/src',
]

const colorFunction = /#[\da-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\s*\(/giu
const themeBranch = /data-ds-dark-theme|prefers-color-scheme\s*:\s*(?:dark|light)/giu
const staticToken = /--dsw-static-[a-z\d-]+/giu
const inlineStyle = /\bstyle\s*=/gu
const tokenReference = /var\((--dsw-[a-z\d-]+)/giu
const tokenDefinition = /(--dsw-[a-z\d-]+)\s*:/giu
const colorProperties = new Set([
  'accent-color', 'background', 'background-color', 'box-shadow', 'caret-color', 'color',
  'fill', 'outline', 'outline-color', 'stroke', 'text-shadow',
])
const borderColorProperty = /^border(?:-(?:block|inline|top|right|bottom|left)(?:-(?:start|end))?)?(?:-color)?$/u
const neutralColorValue = /^(?:0|none|inherit|initial|revert|revert-layer|transparent|currentcolor)$/iu

/** One source location rejected by the strict feature-theme policy. */
export interface ThemeStyleViolation {
  file: string
  line: number
  rule: 'inline-style' | 'literal-color' | 'theme-branch' | 'static-token' | 'undefined-token'
  message: string
}

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split('\n').length
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, comment => comment.replace(/[^\n]/gu, ' '))
}

function pushMatches(
  violations: ThemeStyleViolation[],
  file: string,
  source: string,
  pattern: RegExp,
  rule: ThemeStyleViolation['rule'],
  message: (match: string) => string,
): void {
  pattern.lastIndex = 0
  for (const match of source.matchAll(pattern)) {
    violations.push({ file, line: lineAt(source, match.index), rule, message: message(match[0]) })
  }
}

/**
 * Inspect one feature stylesheet against the strict theme policy.
 * @param source - CSS source without preprocessing.
 * @param file - repository-relative diagnostic path.
 * @param definedTokens - `--dsw-*` variables declared by ui-theme.
 * @returns every policy violation in source order.
 */
export function inspectThemeStyles(
  source: string,
  file: string,
  definedTokens: ReadonlySet<string>,
): ThemeStyleViolation[] {
  const css = withoutComments(source)
  const violations: ThemeStyleViolation[] = []
  pushMatches(violations, file, css, colorFunction, 'literal-color', value => `literal color ${value} must use a semantic --dsw-* token`)
  pushMatches(violations, file, css, themeBranch, 'theme-branch', value => `feature styles must not branch on ${value}`)
  pushMatches(violations, file, css, staticToken, 'static-token', value => `${value} is a palette token; consume a semantic alias instead`)

  const declarations = /([\w-]+)\s*:\s*([^;{}]+)(?:;|(?=\}))/gu
  for (const match of css.matchAll(declarations)) {
    const property = match[1] ?? ''
    const value = (match[2] ?? '').trim()
    const neutralBorder = /^(?:border|outline)/u.test(property) && /\b(?:transparent|currentcolor)\b/iu.test(value)
    const carriesColor = colorProperties.has(property) || borderColorProperty.test(property)
    if (!carriesColor || neutralColorValue.test(value) || neutralBorder || value.includes('var(')) continue
    violations.push({
      file,
      line: lineAt(css, match.index),
      rule: 'literal-color',
      message: `${property} must use a semantic --dsw-* token`,
    })
  }

  tokenReference.lastIndex = 0
  for (const match of css.matchAll(tokenReference)) {
    const token = match[1] ?? ''
    if (definedTokens.has(token)) continue
    violations.push({
      file,
      line: lineAt(css, match.index),
      rule: 'undefined-token',
      message: `${token} is not declared by ui-theme`,
    })
  }
  return violations.sort((left, right) => left.line - right.line || left.rule.localeCompare(right.rule))
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? filesUnder(path) : [path]
  })
}

function themeTokens(): Set<string> {
  const styles = join(root, 'packages/client/ui-theme/src/styles')
  const tokens = new Set<string>()
  for (const file of filesUnder(styles).filter(path => extname(path) === '.css')) {
    tokenDefinition.lastIndex = 0
    for (const match of readFileSync(file, 'utf8').matchAll(tokenDefinition)) tokens.add(match[1] ?? '')
  }
  return tokens
}

/** Inspect React/TypeScript source for presentation that bypasses the feature stylesheet. */
export function inspectPresentationSource(source: string, file: string): ThemeStyleViolation[] {
  const violations: ThemeStyleViolation[] = []
  pushMatches(
    violations, file, source, inlineStyle, 'inline-style',
    () => 'inline style bypasses theme validation; move presentation to a CSS Module',
  )
  pushMatches(
    violations, file, source, colorFunction, 'literal-color',
    value => `inline literal color ${value} must move to a CSS Module and use a semantic --dsw-* token`,
  )
  pushMatches(
    violations, file, source, staticToken, 'static-token',
    value => `${value} is a palette token; consume a semantic alias in a CSS Module`,
  )
  return violations
}

/**
 * Inspect every stylesheet in strict client-package roots.
 * @returns repository-relative violations sorted by file and line.
 */
export function verifyStrictThemePackages(): ThemeStyleViolation[] {
  const tokens = themeTokens()
  return strictRoots.flatMap((directory) => {
    const absolute = join(root, directory)
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
      return [{
        file: directory,
        line: 1,
        rule: 'undefined-token' as const,
        message: 'strict theme root does not exist',
      }]
    }
    return filesUnder(absolute).flatMap((path) => {
      const file = relative(root, path).replaceAll('\\', '/')
      if (path.endsWith('.module.css')) return inspectThemeStyles(readFileSync(path, 'utf8'), file, tokens)
      if (path.endsWith('.ts') || path.endsWith('.tsx')) return inspectPresentationSource(readFileSync(path, 'utf8'), file)
      return []
    })
  }).sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)
}

if (import.meta.main) {
  const violations = verifyStrictThemePackages()
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line}: ${violation.rule}: ${violation.message}`)
  }
  if (violations.length > 0) process.exitCode = 1
}
