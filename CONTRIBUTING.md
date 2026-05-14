# Contributing to @stdiobus/mcpx

Thank you for your interest in contributing to `@stdiobus/mcpx`. This document explains how to get involved, what we expect from contributions, and how the review process works.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Making Changes](#making-changes)
- [Commit Guidelines](#commit-guidelines)
- [Pull Request Process](#pull-request-process)
- [Quality Requirements](#quality-requirements)
- [Reporting Issues](#reporting-issues)
- [Security Vulnerabilities](#security-vulnerabilities)
- [License](#license)

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior to **raman@stdiobus.com**.

## Getting Started

### Before You Contribute

1. **Check existing issues** — search [open issues](https://github.com/stdiobus/mcpx/issues) to see if someone is already working on what you have in mind.
2. **Open an issue first** for non-trivial changes. This avoids wasted effort if the change doesn't align with the project direction. Bug fixes and documentation improvements can go straight to a PR.
3. **Read the docs** — start with the [README](README.md) to understand core concepts (module root, `module.json`, runtimes, env layering).

### What We're Looking For

All contributions are welcome, including:

- Bug fixes with regression tests
- Documentation improvements and corrections
- New test coverage for uncovered edge cases
- Performance improvements with benchmarks (when applicable)
- New features (please discuss first via an issue)

## Development Setup

### Prerequisites

- **Node.js >= 18.0.0** (`node --version` to check)
- **Yarn Classic (1.x)** (recommended) or **npm**
- **Git**

### Setup

```bash
# Fork and clone the repository
git clone https://github.com/stdiobus/mcpx.git
cd mcpx

# Install dependencies
yarn install --frozen-lockfile

# Verify everything works
yarn typecheck
yarn test:unit
yarn build
```

### Project Structure

```
src/                     Production source code (TypeScript, ESM-only)
  cli/                   CLI entry points and commands
  core/                  Core launcher logic (resolution, planning, env, etc.)
  platform/              Cross-platform utilities (paths, fs, os behaviors)
  registry/              Module registry/discovery helpers
  runtimes/              Runtime adapters (nodejs/python/go/rust/shell/docker)
  index.ts               Library entry point (exports)
src/__tests__/           Test suites
  properties/            Property-based tests (fast-check)
  integration/           Integration tests
  e2e/                   End-to-end tests
  system/                System-level tests
```

### Key Commands

| Command | Purpose |
|---------|---------|
| `yarn typecheck` | Type check without emitting (`tsc --noEmit`) |
| `yarn test` | Run all Jest tests |
| `yarn test:unit` | Run unit tests |
| `yarn test:property` | Run property-based tests |
| `yarn test:integration` | Run integration tests |
| `yarn test:e2e` | Run end-to-end tests |
| `yarn test:system` | Run system tests |
| `yarn test:all` | Run the full suite (unit + property + integration + e2e + system) |
| `yarn build` | Build bundle + type declarations into `out/` |
| `yarn build:watch` | Watch build (esbuild) |
| `yarn test:smoke` | Smoke test CLI behavior |
| `yarn test:mcp-e2e` | Smoke test MCP-related end-to-end flows |

## Making Changes

### Branch Naming

Create a branch from `main` using one of these prefixes:

- `feature/` — new functionality
- `fix/` — bug fixes
- `docs/` — documentation only
- `chore/` — maintenance, dependencies, CI
- `refactor/` — code restructuring without behavior change

Example: `fix/windows-path-normalization`.

### Code Conventions

This project uses TypeScript (ESM) with strict type checking. Follow these conventions:

- **Imports** use `.js` extensions where required by NodeNext/ESM resolution patterns used in the repo
- Prefer `import type` for type-only imports
- Keep CLI output stable (tests may assert on formatting)
- Be careful with **stdout vs stderr** in protocol-facing paths (stdout may be used for MCP JSON-RPC transport)

When in doubt, follow the patterns in the surrounding code.

### Testing Requirements

Every code change must include tests when it changes behavior:

- **Bug fixes** — add a regression test that fails without the fix and passes with it
- **New features** — add tests for the happy path and relevant edge cases
- **Refactors** — existing tests must continue to pass; add tests if coverage drops for critical paths

Tests live under `src/__tests__/` and are run via Jest.

### Documentation Requirements

If your change affects user-facing behavior, update the relevant documentation:

- **CLI behavior** — update `README.md` usage examples
- **module.json semantics** — update the README and any inline docs in `src/`
- **New runtime behavior** — document prerequisites and examples

Documentation-only PRs are welcome and appreciated.

## Commit Guidelines

Use [Conventional Commits](https://www.conventionalcommits.org/) format:

```
<type>(<scope>): <short description>

<optional body>
```

### Types

| Type | When to use |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `test` | Adding or updating tests |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `perf` | Performance improvement |
| `chore` | Maintenance (deps, CI, build) |

### Scope (optional)

Use the affected area: `cli`, `core`, `platform`, `registry`, `runtimes`.

### Examples

```
feat(cli): add --json output to list
fix(runtimes): handle missing python executable on windows
docs: clarify module.json entry rules
test(core): add coverage for env layer precedence
chore(deps): bump esbuild
```

Keep commits small and focused. Each commit should represent one logical change.

## Pull Request Process

### 1. Before Submitting

Run the quality gate locally:

```bash
yarn typecheck        # Must pass with zero errors
yarn test:unit        # Must pass
yarn build            # Must succeed
yarn test:e2e         # Run if your change affects runtime behavior
```

### 2. Open the PR

- Target the `main` branch
- Title format: `<type>(<scope>): <short description>` (same as commit convention)
- Link related issues with `Closes #123`
- Include steps to verify (commands and expected output)

### 3. Review Process

- CI must pass (typecheck, build, tests; see `.github/workflows/ci.yml`)
- Reviewers may request changes — please address all feedback before re-requesting review

### 4. After Approval

A maintainer will merge your PR.

## Quality Requirements

These are enforced by CI and are non-negotiable:

- [ ] `yarn typecheck` passes with zero errors
- [ ] Relevant test suites pass (`yarn test:unit` at minimum; more if you touched integration/runtime behavior)
- [ ] `yarn build` succeeds and produces expected artifacts in `out/`
- [ ] No secrets, tokens, or credentials in the code or tests
- [ ] stdout remains reserved for wire-protocol output in protocol-facing code paths
- [ ] Public API contracts unchanged (or change is intentional, discussed, and documented)
- [ ] New/changed behavior covered by tests

## Reporting Issues

Use the [issue templates](https://github.com/stdiobus/mcpx/issues/new/choose) if enabled:

- **Bug Report** — for reproducible bugs. Include version, Node.js version, OS, and steps to reproduce.
- **Feature Request** — for new functionality. Describe the problem, proposed solution, and alternatives considered.

Please search existing issues before opening a new one.

## Security Vulnerabilities

**Do not open a public issue for security vulnerabilities.**

Report security issues privately to **raman@stdiobus.com**.

## License

By submitting a contribution to this project, you agree that your contribution will be licensed under the [Apache License 2.0](LICENSE), the same license that covers the project. You represent that you have the right to submit the contribution and that it does not violate any third-party rights.

