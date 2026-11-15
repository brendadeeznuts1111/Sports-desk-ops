# Bun lint rules used for this branch

These mistakes were found with canary `bun lint` (not the 1.4.4 pin, which has no built-in `bun lint`). The repo lint script and bunfig were not changed.

Hunt rules:

- `bun/prefer-builtin-sleep`
- `bun/prefer-timeout-signal`
- `bun/no-cwd-dependent-path`
- `bun/prefer-url-for-sibling-files`
- `bun/no-env-at-module-scope`
- `preserve-caught-error`
- `no-throw-literal`
- `unicorn/error-message`
- `unicorn/throw-new-error`
- `prefer-promise-reject-errors`
- `unicorn/no-invalid-fetch-options`

Fixes stay in application code. Worker/browser code does not use `Bun.sleep`. Intentional module-scope env reads and repo-root CLI paths were reviewed and left in place.
