# Engram - Project Rules

## Validation Gate (MANDATORY)

After ANY code change, run:
```bash
bun run validate
```

Rules:
- Do NOT proceed to the next task if validation fails
- Fix failures immediately, re-run validation, show passing output
- Show validation output in responses so progress is visible
- At slice completion, run full validation and report final status

## Project Context

Engram is an MCP server providing persistent memory for AI agents.
- Runtime: Bun
- Database: SQLite via `bun:sqlite`
- Protocol: MCP over stdio
- Vector search: sqlite-vec (Slice 2+)

## Code Standards

- TypeScript strict mode
- Use `bun:sqlite` for database operations
- Use `@modelcontextprotocol/sdk` for MCP protocol
- Prefer explicit types over inference for public APIs
- Keep files small and focused

## Testing

- Unit tests with Bun's test runner
- Test database uses `:memory:` SQLite
- Test files live in `test/` directory
- Name pattern: `*.test.ts`

## Linting

- Use oxlint for linting
- Run via `bun run lint`
