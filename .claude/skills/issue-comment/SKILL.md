---
name: issue-comment
description: Post a short progress comment on a TableMax GitHub issue (plan written, tests green, blocked, question for a teammate). Use when the user or the /work-issue flow wants to tell the team something on issue N.
argument-hint: "<issue-number> <text>"
---

# Comment on an issue

Arguments: `$ARGUMENTS` — the first word is the issue number, the rest is the text. Stop and
ask if the number is missing or not a number, or if there is no text.

1. `gh issue view <n> --json state,title --jq '"\(.state): \(.title)"'` — it must exist.
2. Check the text: short (a few lines), factual, **no secrets** (passwords, tokens, keys,
   connection URLs with a password, unredacted logs). Remove anything sensitive before posting.
3. Post it with a quoted heredoc, so the shell expands nothing in the text:
   ```bash
   gh issue comment <n> --body-file - <<'EOF'
   <text>
   EOF
   ```
4. Print the comment URL that `gh` returns.
