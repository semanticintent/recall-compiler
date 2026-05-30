import { Command } from 'commander'
import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { resolve, dirname, basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { compile, compileFromSource, loadPlugins } from '../../compiler/index.js'

// ─────────────────────────────────────────────────────────
// Source extraction
// ─────────────────────────────────────────────────────────

const STARS = '*'.repeat(54)

function extractEmbeddedSource(html: string): string | null {
  // Comment block format:
  //   <!--
  //   ******************************************************
  //   * RECALL COMPILED OUTPUT
  //   * SOURCE: (embedded below)
  //   * RECALL VERSION: x.x.x
  //   ******************************************************
  //
  //   * source line
  //   *
  //   * source line
  //
  //   ******************************************************
  //   -->

  const headerMarker = `<!--\n${STARS}\n* RECALL COMPILED OUTPUT`
  const start = html.indexOf(headerMarker)
  if (start === -1) return null

  // Skip past the header block (second STARS line)
  const headerEnd = html.indexOf(`\n${STARS}\n`, start + headerMarker.length)
  if (headerEnd === -1) return null

  const sourceStart = headerEnd + STARS.length + 2  // past \n*{54}\n

  // Find the closing STARS line that ends the source block
  const sourceEnd = html.indexOf(`\n${STARS}\n-->`, sourceStart)
  if (sourceEnd === -1) return null

  const block = html.slice(sourceStart, sourceEnd)

  // Strip `* ` prefix (content lines) or `*` (blank lines), drop leading/trailing blank
  const lines = block.split('\n')
  const source = lines
    .map(l => {
      if (l === '')   return null        // blank separator lines around the block
      if (l === '*')  return ''          // blank source line
      if (l.startsWith('* ')) return l.slice(2)
      return l                           // shouldn't happen — emit as-is
    })
    .filter((l): l is string => l !== null)
    .join('\n')

  return source.trim() ? source : null
}

// ─────────────────────────────────────────────────────────
// Normalise for comparison — strip the embedded source
// comment from both artifacts before comparing, so that
// compile-time timestamps or version differences in the
// header don't cause false positives.
// ─────────────────────────────────────────────────────────

function stripSourceComment(html: string): string {
  const start = html.indexOf(`<!--\n${STARS}\n* RECALL COMPILED OUTPUT`)
  if (start === -1) return html
  const end = html.indexOf('-->', start)
  if (end === -1) return html
  return (html.slice(0, start) + html.slice(end + 3)).trim()
}

// ─────────────────────────────────────────────────────────
// Fetch HTML from URL (Node 22 built-in fetch)
// ─────────────────────────────────────────────────────────

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'recall-validate/1.2' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
  return res.text()
}

// ─────────────────────────────────────────────────────────
// Validate a local .html file
// ─────────────────────────────────────────────────────────

async function validateLocal(
  htmlPath: string,
  opts: { strict: boolean; format: string; quiet: boolean }
): Promise<0 | 1> {
  const label = htmlPath

  const html = readFileSync(htmlPath, 'utf-8')
  const source = extractEmbeddedSource(html)

  if (!source) {
    if (!opts.quiet) {
      if (opts.format === 'json') {
        process.stdout.write(JSON.stringify({ ok: false, code: 'VALID-002', file: label, message: 'No embedded RECALL source found in this HTML file.' }, null, 2) + '\n')
      } else {
        process.stderr.write(`\n  VALID-002  ${label}\n`)
        process.stderr.write(`  No embedded RECALL source found.\n`)
        process.stderr.write(`  Only HTML compiled by recall compile embeds its source.\n\n`)
      }
    }
    return 1
  }

  // Try the .rcl file alongside the .html first — gives accurate COPY FROM resolution
  const rclPath = join(dirname(htmlPath), basename(htmlPath, '.html') + '.rcl')
  let recompiled: string

  if (existsSync(rclPath)) {
    const tempDir = join(tmpdir(), `recall-validate-${process.pid}`)
    mkdirSync(tempDir, { recursive: true })
    try {
      await loadPlugins(rclPath)
      const result = compile(rclPath, tempDir, { strict: opts.strict })
      if (!result.ok || !result.outputPath) {
        if (!opts.quiet) {
          if (opts.format === 'json') {
            process.stdout.write(JSON.stringify({ ok: false, code: 'VALID-003', file: label, message: `Recompile failed: ${result.error}` }, null, 2) + '\n')
          } else {
            process.stderr.write(`\n  VALID-003  ${label}\n`)
            process.stderr.write(`  Recompile failed: ${result.error}\n\n`)
          }
        }
        return 1
      }
      recompiled = readFileSync(result.outputPath, 'utf-8')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  } else {
    // No .rcl alongside — use in-memory compilation from embedded source
    // Note: COPY FROM / LOAD FROM are not resolved in this path
    const result = compileFromSource(source, { strict: opts.strict })
    if (!result.ok || !result.html) {
      if (!opts.quiet) {
        if (opts.format === 'json') {
          process.stdout.write(JSON.stringify({ ok: false, code: 'VALID-003', file: label, message: `Recompile of embedded source failed: ${result.error}` }, null, 2) + '\n')
        } else {
          process.stderr.write(`\n  VALID-003  ${label}\n`)
          process.stderr.write(`  Recompile of embedded source failed: ${result.error}\n`)
          process.stderr.write(`  Note: .rcl source file not found — COPY FROM / LOAD FROM cannot be resolved.\n\n`)
        }
      }
      return 1
    }
    recompiled = result.html
  }

  // Compare, stripping the source comments from both sides
  const expectedBody = stripSourceComment(recompiled)
  const actualBody   = stripSourceComment(html)

  if (expectedBody !== actualBody) {
    if (!opts.quiet) {
      if (opts.format === 'json') {
        process.stdout.write(JSON.stringify({ ok: false, code: 'VALID-001', file: label, message: 'Compiled HTML does not match the embedded source. The file may have been modified after compilation.' }, null, 2) + '\n')
      } else {
        process.stderr.write(`\n  VALID-001  ${label}\n`)
        process.stderr.write(`  The compiled output does not match the embedded source.\n`)
        process.stderr.write(`  The HTML file may have been modified after compilation.\n`)
        process.stderr.write(`  Run: recall compile ${rclPath} to regenerate a clean artifact.\n\n`)
      }
    }
    return 1
  }

  if (!opts.quiet) {
    if (opts.format === 'json') {
      process.stdout.write(JSON.stringify({ ok: true, file: label, message: 'Artifact is valid — matches its embedded source.' }, null, 2) + '\n')
    } else {
      process.stdout.write(`\n  ✓ VALID  ${label}\n`)
      process.stdout.write(`  Artifact matches its embedded source.\n\n`)
    }
  }
  return 0
}

// ─────────────────────────────────────────────────────────
// Validate a URL
// ─────────────────────────────────────────────────────────

async function validateUrl(
  url: string,
  opts: { strict: boolean; format: string; quiet: boolean }
): Promise<0 | 1> {
  let html: string
  try {
    html = await fetchHtml(url)
  } catch (err) {
    process.stderr.write(`  Cannot fetch ${url}: ${(err as Error).message}\n`)
    return 1
  }

  const source = extractEmbeddedSource(html)

  if (!source) {
    if (!opts.quiet) {
      if (opts.format === 'json') {
        process.stdout.write(JSON.stringify({ ok: false, code: 'VALID-002', file: url, message: 'No embedded RECALL source found at this URL.' }, null, 2) + '\n')
      } else {
        process.stderr.write(`\n  VALID-002  ${url}\n`)
        process.stderr.write(`  No embedded RECALL source found.\n\n`)
      }
    }
    return 1
  }

  // URL mode — always uses in-memory compilation (no access to local files)
  const result = compileFromSource(source, { strict: opts.strict })
  if (!result.ok || !result.html) {
    if (!opts.quiet) {
      if (opts.format === 'json') {
        process.stdout.write(JSON.stringify({ ok: false, code: 'VALID-003', file: url, message: `Recompile failed: ${result.error}` }, null, 2) + '\n')
      } else {
        process.stderr.write(`\n  VALID-003  ${url}\n`)
        process.stderr.write(`  Recompile of embedded source failed: ${result.error}\n\n`)
      }
    }
    return 1
  }

  const expectedBody = stripSourceComment(result.html)
  const actualBody   = stripSourceComment(html)

  if (expectedBody !== actualBody) {
    if (!opts.quiet) {
      if (opts.format === 'json') {
        process.stdout.write(JSON.stringify({ ok: false, code: 'VALID-001', file: url, message: 'Live page does not match its embedded source. The HTML may have been modified after compilation.' }, null, 2) + '\n')
      } else {
        process.stderr.write(`\n  VALID-001  ${url}\n`)
        process.stderr.write(`  The live page does not match its embedded source.\n`)
        process.stderr.write(`  The HTML may have been modified after compilation, or the page uses COPY FROM / LOAD FROM\n`)
        process.stderr.write(`  that cannot be resolved remotely. Validate the local .html file for a definitive check.\n\n`)
      }
    }
    return 1
  }

  if (!opts.quiet) {
    if (opts.format === 'json') {
      process.stdout.write(JSON.stringify({ ok: true, file: url, message: 'Live page is valid — matches its embedded source.' }, null, 2) + '\n')
    } else {
      process.stdout.write(`\n  ✓ VALID  ${url}\n`)
      process.stdout.write(`  Live page matches its embedded source.\n\n`)
    }
  }
  return 0
}

// ─────────────────────────────────────────────────────────
// Command
// ─────────────────────────────────────────────────────────

export const validateCommand = new Command('validate')
  .description('Verify a compiled RECALL artifact matches its embedded source')
  .argument('<target>', 'path to a compiled .html file, or a URL (https://...)')
  .option('--strict', 'treat warnings as errors during recompile')
  .option('--format <fmt>', 'output format: text (default) or json', 'text')
  .option('--quiet', 'no output — use exit code only (0=valid, 1=invalid)')
  .addHelpText('after', `
  Validate a local compiled file:
    recall validate page.html

  Validate a live URL:
    recall validate https://recall.semanticintent.dev

  Machine-readable output (for CI):
    recall validate page.html --format json
    recall validate page.html --quiet   # exit 0 = valid, exit 1 = invalid

  How it works:
    Every file compiled by recall compile embeds its .rcl source in an
    HTML comment. recall validate extracts that source, recompiles it,
    and verifies the output matches the live artifact.

    If the .rcl source file exists alongside the .html, it is used for
    recompilation — COPY FROM and LOAD FROM are resolved correctly.
    If only the .html exists (or a URL is given), the embedded source
    is recompiled in-memory. Files that use COPY FROM or LOAD FROM may
    report VALID-001 in this mode even if valid; validate locally with
    the .rcl alongside for a definitive result.

  Exit codes:
    0 — artifact is valid
    1 — VALID-001 (mismatch), VALID-002 (no embedded source), or VALID-003 (recompile failed)`)
  .action(async (target: string, opts: { strict?: boolean; format: string; quiet?: boolean }) => {
    const isUrl    = target.startsWith('http://') || target.startsWith('https://')
    const resolvedOpts = {
      strict: opts.strict  ?? false,
      format: opts.format  ?? 'text',
      quiet:  opts.quiet   ?? false,
    }

    let exitCode: 0 | 1

    if (isUrl) {
      exitCode = await validateUrl(target, resolvedOpts)
    } else {
      const absPath = resolve(target)
      if (!existsSync(absPath)) {
        process.stderr.write(`File not found: ${absPath}\n`)
        process.exit(1)
      }
      if (!absPath.endsWith('.html')) {
        process.stderr.write(`Expected a .html file or a URL. Got: ${target}\n`)
        process.exit(1)
      }
      exitCode = await validateLocal(absPath, resolvedOpts)
    }

    process.exit(exitCode)
  })
