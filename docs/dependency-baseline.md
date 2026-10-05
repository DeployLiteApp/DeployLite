# Dependency security baseline

The P2 memory-foundation pull request exposed eleven HIGH findings in the
baseline lockfile scan. The required scan remains unchanged and fail-closed.

The existing override policy now pins the published patch releases
`fastify@5.12.2`, `brace-expansion@5.0.11`, `js-yaml@4.3.2`, `sharp@0.35.4`
and `undici@7.29.1`.

`braces@3.0.3` has no verified patched release for CVE-2026-93687. Its only
dependency path was the shadcn scaffolding CLI. The application imported only
the CLI package's Tailwind stylesheet, so it now imports the identical local
copy in `apps/web/src/styles/vendor/shadcn/`, with the upstream MIT license and
archive integrity recorded alongside it. Existing components and their
configuration remain in place. The lockfile no longer includes the CLI or
its glob-parser dependency chain.

Preparation used pnpm 9.15.4 to regenerate only the lockfile, with scripts
disabled and no dependency installation. A frozen, offline lockfile check
passed. The stylesheet matched the integrity-verified published archive byte
for byte. Full quality, PostgreSQL, filesystem and image vulnerability scans
must pass on the exact hosted CI candidate before merge.

This prerequisite does not complete P2 acceptance or deploy an application.
