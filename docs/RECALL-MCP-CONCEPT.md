# recall-mcp — Concept Document

> Status: Concept — not yet implemented
> Date: 2026-05-30
> Origin: Strategic review of RECALL's AI-first positioning

---

## The Idea

A minimal, standalone MCP server that exposes RECALL as a publishing tool for AI agents.
Four tools. Nothing more.

The existing `semantic-cal-workflow-mcp` uses RECALL as an HTML emission engine — brief JSON
goes in, HTML comes out. RECALL is the implementation detail, invisible to the caller.

`recall-mcp` inverts that: RECALL is the interface. The AI writes RECALL source directly.
The compiler validates it. The artifact carries its own provenance. The MCP is just the
transport layer between an AI agent and the compiler.

---

## The Wow Moment This Enables

```
# AI writes it
recall_check(source)      → clean diagnostics
recall_compile(source)    → self-contained HTML

# Six months later:
recall_validate(html)     → ✓ VALID  authored by: AI compositor
```

The proof lives in the artifact. No database. No git history. No trust required.
That is the AI-first claim made operational — not "AI can write it" (anything can),
but "the compiler knows who wrote what and the artifact proves it permanently."

---

## Four Tools

### `recall_compile`

Takes a `.rcl` source string. Returns self-contained HTML and a diagnostic array.
Stateless — no file I/O. The AI calls this in a loop until diagnostics are clean.

```json
{
  "name": "recall_compile",
  "description": "Compile a RECALL source string to self-contained HTML",
  "inputSchema": {
    "source": "string — valid .rcl source",
    "strict": "boolean — treat warnings as errors (optional, default false)"
  },
  "returns": {
    "ok": "boolean",
    "html": "string — compiled HTML (when ok: true)",
    "diagnostics": "SourceDiagnostic[] — errors and warnings"
  }
}
```

### `recall_check`

Takes a source string. Returns typed diagnostics without compiling to HTML.
The AI uses this to pre-flight source before a full compile cycle.

```json
{
  "name": "recall_check",
  "description": "Type-check a RECALL source string without producing output",
  "inputSchema": {
    "source": "string",
    "strict": "boolean (optional)"
  },
  "returns": {
    "ok": "boolean",
    "errors": "SourceDiagnostic[]",
    "warnings": "SourceDiagnostic[]"
  }
}
```

### `recall_validate`

Takes a compiled HTML string or path. Extracts the embedded `.rcl` source, recompiles it,
and compares the output. Returns PASS/FAIL plus the embedded AUDIT block if present.
This is the provenance surface — the tool that makes "the artifact proves itself" real.

```json
{
  "name": "recall_validate",
  "description": "Verify a compiled RECALL artifact matches its embedded source",
  "inputSchema": {
    "html": "string — compiled HTML content"
  },
  "returns": {
    "ok": "boolean",
    "code": "VALID-001 | VALID-002 | VALID-003 (when ok: false)",
    "audit": "{ createdBy, createdDate, changeLog } | null"
  }
}
```

### `recall_diff`

Takes two source strings. Returns structured changes at the division level — not a text
diff. The human reviews what the AI compositor changed between drafts.

```json
{
  "name": "recall_diff",
  "description": "Semantic diff between two RECALL source strings",
  "inputSchema": {
    "sourceA": "string",
    "sourceB": "string"
  },
  "returns": {
    "changes": "Change[] — DATA, PROCEDURE, and IDENTIFICATION changes by division"
  }
}
```

---

## The Interaction Loop

```
1. Human states intent in natural language
2. AI writes RECALL source (IDENTIFICATION + DATA + PROCEDURE DIVISION)
3. recall_check → catches type errors → AI fixes → repeat until clean
4. recall_compile → emits self-contained HTML
5. recall_validate → seals provenance, reads AUDIT DIVISION if present
6. Human reviews recall_diff between draft versions
```

Every step is validated by the compiler, not by convention. The AI cannot ship an
artifact with a malformed AUDIT DIVISION. The compiler enforces it.

---

## What It Is Not

- Not a workflow MCP (no case brief schema, no index.json, no file I/O)
- Not a replacement for `semantic-cal-workflow-mcp` (that is domain-specific)
- Not an AI that writes pages for you (the AI uses RECALL, the MCP is just transport)

The distinction matters: `recall-mcp` makes RECALL's AI-first design demonstrable
in a single Claude Desktop session. Domain-specific MCPs (like cal-workflow) build on
top of that foundation.

---

## Package Shape

```
@semanticintent/recall-mcp
├── src/
│   ├── server.ts          — MCP server entry point (stdio transport)
│   ├── tools/
│   │   ├── compile.ts     — recall_compile tool
│   │   ├── check.ts       — recall_check tool
│   │   ├── validate.ts    — recall_validate tool
│   │   └── diff.ts        — recall_diff tool
│   └── index.ts
├── package.json
└── README.md
```

Depends on `@semanticintent/recall-compiler`. No other runtime dependencies.
The compiler is already a pure function library — the MCP is a thin wrapper.

---

## Why Four Tools and No More

The point of `recall-mcp` is to make the AI-first claim *demonstrable*, not to build
a complete publishing pipeline. Anyone can install it, open Claude Desktop, and run
the full compile → validate loop in one session. That is the demo.

Domain-specific workflows (templates, brief schemas, file output, index management)
belong in purpose-built MCPs that depend on `recall-mcp` or call the compiler directly.
The primitive layer should stay primitive.

---

## Relationship to Existing Work

| Project | Role |
|---|---|
| `@semanticintent/recall-compiler` | The engine — pure functions, no MCP coupling |
| `@semanticintent/recall-mcp` | Four-tool MCP wrapper — makes compiler AI-accessible |
| `semantic-cal-workflow-mcp` | Domain-specific pipeline — 6D case studies, file I/O, index |
| `recall-vscode` | Editor integration — LSP, syntax highlighting |

`recall-mcp` sits between the compiler and any domain-specific orchestration.
It is the layer that makes the "AI-first language" claim testable by anyone.
