Closes #

## Summary

<!-- What changes and why, in a few lines. -->

## How it was tested

<!-- Commands you ran and the end of their output. -->

```text
$ pnpm test
...
$ pnpm lint
...
```

## Screenshots (UI changes)

<!-- Before / after, and the manual steps you checked. Delete if no UI change. -->

## Checklist

- [ ] `pnpm test` green
- [ ] `pnpm lint` green (tsc + clippy `-D warnings`)
- [ ] `pnpm test:rust` green (if `src-tauri/`, `docker-compose.test.yml`, `tests/docker/` or test scripts changed)
- [ ] No secret, token, real password or private key in the diff
- [ ] User-visible strings in `src/lib/strings.ts`
- [ ] Commits follow `<emoji> <type>(<scope>): <description>`
