import { Command } from 'commander'
import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { watch, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join, basename, dirname } from 'node:path'
import { compile, loadPlugins } from '../../compiler/index.js'

// ─────────────────────────────────────────────────────────
// SSE hot-reload injection
// ─────────────────────────────────────────────────────────

const SSE_SCRIPT = `<script>
(function() {
  var src = '/__recall_events';
  function connect() {
    var es = new EventSource(src);
    es.onmessage = function() { location.reload(); };
    es.onerror   = function() { es.close(); setTimeout(connect, 1500); };
  }
  connect();
})();
</script>`

function injectSse(html: string): string {
  return html.includes('</body>')
    ? html.replace('</body>', SSE_SCRIPT + '\n</body>')
    : html + SSE_SCRIPT
}

// ─────────────────────────────────────────────────────────
// File helpers
// ─────────────────────────────────────────────────────────

function findRclFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter(f => f.endsWith('.rcl') && statSync(join(dir, f)).isFile())
    .map(f => join(dir, f))
}

function htmlPathFor(rclPath: string): string {
  return join(dirname(rclPath), basename(rclPath, '.rcl') + '.html')
}

// ─────────────────────────────────────────────────────────
// SSE client pool
// ─────────────────────────────────────────────────────────

const clients = new Set<ServerResponse>()

function broadcast(label: string) {
  process.stdout.write(`  ✦ ${label} — reloading ${clients.size} client${clients.size === 1 ? '' : 's'}\n`)
  for (const client of clients) {
    client.write('data: reload\n\n')
  }
}

// ─────────────────────────────────────────────────────────
// Debounce
// ─────────────────────────────────────────────────────────

function debounce(fn: (...args: unknown[]) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null
  return (...args: unknown[]) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; fn(...args) }, ms)
  }
}

// ─────────────────────────────────────────────────────────
// Recompile helper
// ─────────────────────────────────────────────────────────

async function recompile(rclPath: string): Promise<boolean> {
  try {
    await loadPlugins(rclPath)
    const result = compile(rclPath)
    if (result.ok) {
      process.stdout.write(`  ✓ compiled  ${basename(rclPath)}\n`)
      return true
    } else {
      process.stderr.write(`  ✗ error     ${basename(rclPath)}: ${result.error}\n`)
      return false
    }
  } catch (err) {
    process.stderr.write(`  ✗ error     ${basename(rclPath)}: ${(err as Error).message}\n`)
    return false
  }
}

// ─────────────────────────────────────────────────────────
// Index page (directory mode)
// ─────────────────────────────────────────────────────────

function makeIndex(rclFiles: string[]): string {
  const items = rclFiles.map(f => {
    const name = basename(f, '.rcl')
    return `<li><a href="/${name}.html">${name}.html</a></li>`
  }).join('\n      ')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RECALL dev server</title>
  <style>
    body { font-family: monospace; background: #0d1117; color: #c9d1d9; padding: 2rem; }
    h1   { color: #58a6ff; font-size: 1rem; letter-spacing: 0.1em; text-transform: uppercase; }
    ul   { list-style: none; padding: 0; }
    li   { margin: 0.5rem 0; }
    a    { color: #79c0ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>RECALL dev server</h1>
  <ul>
      ${items}
  </ul>
  ${SSE_SCRIPT}
</body>
</html>`
}

// ─────────────────────────────────────────────────────────
// Command
// ─────────────────────────────────────────────────────────

export const serveCommand = new Command('serve')
  .description('Watch .rcl files and serve compiled HTML with hot reload')
  .argument('<path>', '.rcl file or directory of .rcl files to watch and serve')
  .option('--port <n>', 'port to listen on', '4321')
  .addHelpText('after', `
  Single file:
    recall serve page.rcl
    recall serve page.rcl --port 8080

  Directory — serves all .rcl files with an index:
    recall serve src/
    recall serve src/ --port 3000

  Hot reload via SSE — every browser tab connected to the dev server
  automatically reloads when any watched .rcl or .rcpy file changes.`)
  .action(async (input: string, opts: { port: string }) => {
    const absInput = resolve(input)
    const port     = parseInt(opts.port, 10)

    if (!existsSync(absInput)) {
      process.stderr.write(`Not found: ${absInput}\n`)
      process.exit(1)
    }

    const isDir    = statSync(absInput).isDirectory()
    const rclFiles = isDir ? findRclFiles(absInput) : [absInput]

    if (rclFiles.length === 0) {
      process.stderr.write(`No .rcl files found in: ${absInput}\n`)
      process.exit(1)
    }

    // ── Initial compile ──────────────────────────────────
    process.stdout.write(`\n  RECALL dev server  (${rclFiles.length} file${rclFiles.length === 1 ? '' : 's'})\n\n`)
    for (const file of rclFiles) {
      await recompile(file)
    }

    // ── HTTP server ──────────────────────────────────────
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = (req.url ?? '/').split('?')[0]

      // SSE endpoint
      if (url === '/__recall_events') {
        res.writeHead(200, {
          'Content-Type':  'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection':    'keep-alive',
        })
        res.write(': connected\n\n')
        clients.add(res)
        req.on('close', () => clients.delete(res))
        return
      }

      // Directory index
      if (isDir && (url === '/' || url === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(makeIndex(rclFiles))
        return
      }

      // Serve .html files (with SSE injected)
      let htmlPath: string

      if (!isDir && (url === '/' || url === `/${basename(rclFiles[0], '.rcl')}.html`)) {
        htmlPath = htmlPathFor(rclFiles[0])
      } else {
        const name = url.replace(/^\//, '')
        htmlPath   = isDir
          ? join(absInput, name)
          : join(dirname(rclFiles[0]), name)
      }

      if (!htmlPath.endsWith('.html') || !existsSync(htmlPath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('Not found')
        return
      }

      const html = readFileSync(htmlPath, 'utf-8')
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(injectSse(html))
    })

    server.listen(port, () => {
      const url = `http://localhost:${port}`
      process.stdout.write(`\n  Listening  ${url}\n\n`)
      if (!isDir) {
        process.stdout.write(`  → ${url}/${basename(rclFiles[0], '.rcl')}.html\n\n`)
      }
    })

    // ── File watching (one watcher per directory) ────────
    const watchDirs = new Map<string, string[]>()
    for (const file of rclFiles) {
      const dir = dirname(file)
      if (!watchDirs.has(dir)) watchDirs.set(dir, [])
      watchDirs.get(dir)!.push(file)
    }

    for (const [dir, filesInDir] of watchDirs) {
      const debouncedRecompile = debounce(async (filename: unknown) => {
        const fname = String(filename)

        if (fname.endsWith('.rcl')) {
          const changed = join(dir, fname)
          if (!filesInDir.includes(changed)) return
          process.stdout.write(`  ⟳  ${fname}\n`)
          const ok = await recompile(changed)
          if (ok) broadcast(fname)
        }

        if (fname.endsWith('.rcpy')) {
          // A copybook changed — recompile all .rcl files in this dir
          process.stdout.write(`  ⟳  ${fname}  (copybook — recompiling all)\n`)
          let anyOk = false
          for (const file of filesInDir) {
            const ok = await recompile(file)
            if (ok) anyOk = true
          }
          if (anyOk) broadcast(fname)
        }
      }, 250)

      watch(dir, (_event, filename) => {
        if (!filename) return
        if (filename.endsWith('.rcl') || filename.endsWith('.rcpy')) {
          debouncedRecompile(filename)
        }
      })
    }

    // Keep the process alive
    process.on('SIGINT', () => {
      process.stdout.write('\n  Stopped.\n')
      server.close()
      process.exit(0)
    })
  })
