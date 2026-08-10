# Contributing

## Dev setup

```bash
pnpm install
pnpm run build
pnpm run typecheck
pnpm run lint
pnpm run test
```

`build`'s `tsc` excludes `*.test.ts` (test files shouldn't end up in the published `dist/`), so it
never type-checks tests. `typecheck` runs the same compiler over the whole program, tests included,
via `tsconfig.test.json` (extends the base config, `noEmit`, no exclusion). `vitest run` itself
doesn't type-check either -- it transpiles with esbuild, which strips types without checking them --
so `typecheck` is the only step that would catch a type error confined to a test file.

Node version is pinned in `.nvmrc`.

### Regenerating API types

`src/generated/trilium-schema.d.ts` is generated from TriliumNext/Trilium's bundled ETAPI OpenAPI
spec, pinned to a release tag (a running Trilium server doesn't serve this spec over HTTP itself --
see `scripts/generate-types.ts`'s own doc comment):

```bash
pnpm run generate:types -- v0.104.1
```

Re-run this after bumping the Trilium version this project targets. Note the repo name:
`TriliumNext/Trilium`, not `TriliumNext/Notes` (that repo is archived; see AGENTS.md).

Note: `openapi-typescript`'s codegen currently only supports TypeScript ^5.x, while this project
builds against the latest TypeScript major. `generate:types` runs the generator through `pnpm dlx`
in an isolated resolution so it gets a compatible TypeScript without downgrading the project's own
devDependency.

## Commit messages

This repo releases via [semantic-release](https://semantic-release.gitbook.io/semantic-release/):
every commit message on `main` must follow [Conventional Commits](https://www.conventionalcommits.org/),
because the release automation reads the commit history to decide what to publish. There is no
manual version bump -- don't edit `version` in `package.json`.

| Prefix | Effect |
| --- | --- |
| `fix: ...` | patch release |
| `feat: ...` | minor release |
| `feat!: ...` or a `BREAKING CHANGE:` footer | major release |
| `chore:`, `docs:`, `refactor:`, `test:`, `ci:` | no release |

## Release process

Merging to `main` runs [`.github/workflows/release.yml`](./.github/workflows/release.yml), which
calls [myceliumhq/.github](https://github.com/myceliumhq/.github)'s reusable release workflow:
build, test, then `semantic-release` (config in `.releaserc.json`) computes the next version from
commits since the last release tag, publishes to npm, and creates a GitHub release with generated
notes.

Requires an `NPM_TOKEN` secret (an npm automation token with publish access to `@myceliumhq`) on
this repo or inherited from an org-level secret -- releases fail cleanly with a clear error until
that's configured.
