# CLAUDE.md

## Working agreements

* **Add a line to `public/updates.txt` when you ship a user-visible change.** Newest last; the footer reads the file and shows the final line. Internal changes (refactors, tests, tooling) do not get a line.
* Keep `lib/` pure: no React, DOM, or network access. Browser side effects belong in `client/`, UI in `components/`.
* Before pushing, run `npm run typecheck`, `npm test`, and `npm run build`; all must pass.
