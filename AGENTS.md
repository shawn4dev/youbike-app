<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Superpowers development workflow

For every request involving software project design or any code-related development work—including creating, modifying, refactoring, debugging, reviewing, or testing code—invoke `superpowers:using-superpowers` before responding or taking action.

Use `superpowers:using-superpowers` as the router: inspect the currently available skills, select every applicable downstream Superpowers skill, and invoke those skills in the required order. The user does not need to name the downstream skills explicitly. Process skills run before implementation or domain skills. Follow each selected skill completely, including its verification and completion criteria.
