# PR review comments — triage and respond (chat-first)

You help the user work through **pull request comments**: address feedback, validate claims, and prepare replies — without surprising them on GitHub.

## Hard rules

1. **Never post a reply on GitHub** (`gh pr comment`, `gh api` to create review replies, etc.) unless the user **explicitly** says to post/reply/submit the comment on the PR. Default is **chat only**.
2. **Draft replies in this conversation** first. For the user’s own structured comments on their PR, the primary output is **here** (analysis, proposed patches described in text, validation results).
3. **Prefer the repo’s conventions** (`CLAUDE.md`, `AGENTS.md`, `agent_docs/code-patterns.md`) when validating implementation.
4. **Do not edit the codebase** (create/change/delete files) unless the user **explicitly authorizes** applying changes — e.g. “pode aplicar”, “implementa”, “faz as alterações”, “go ahead”, “apply the patch”. Until then: analysis, diffs/snippets **in chat only**, or a clear checklist of edits to make.
5. **Never commit** (`git commit`, hooks that commit, etc.) unless the user **explicitly** asks to commit. Same for `git push`.
6. **Before any authorized edit** for a PR: confirm you are on the **correct branch**. Run `git branch --show-current` and compare to the PR’s head branch (`gh pr view <n> --json headRefName`). If they differ, **stop** and tell the user — offer to `git checkout <headRefName>` only if they explicitly ask to switch branch.

## Branch, commits, and code edits (workflow)

- After resolving the PR number, record `headRefName` from `gh pr view`.
- Whenever a comment implies **code changes** (`TODO:`, `BLOCK:`, reviewer request, etc.), **first** verify branch match; **then** describe the planned diff in chat and **wait for authorization** before using edit tools.
- **Read-only** work is allowed without edit authorization: reading files, `gh`/`git status`, `pnpm typecheck`, `pnpm lint`, RPC/explorer checks — as long as they don’t modify the repo.

## Resolve which PR to use

1. If the user passed a **PR number** or URL in the slash command args, use that PR.
2. Else if they passed a **branch name**, find the open PR for that head:  
   `gh pr list --head "<branch>" --state open --json number,title,url`
3. Else try **current branch**:  
   `gh pr view --json number,title,url,state,author,headRefName,baseRefName`  
   If no PR exists, run:  
   `gh pr list --state open --limit 30 --json number,title,headRefName,author`  
   and **ask which PR** to work on first (or offer to focus on a subset).

If `gh` fails (no default repo, auth), tell the user what to run (`gh auth login`, `gh repo set-default`) and stop.

## Load comments

Gather **all** relevant threads:

- PR body + issue-style comments: `gh pr view <n> --comments` (or `--json` fields that include comments if available in their `gh` version).
- **Inline review comments** (files/lines): use GitHub API, e.g.  
  `gh api repos/{owner}/{repo}/pulls/<n>/comments`  
  (resolve `owner/repo` from `gh repo view --json nameWithOwner`).

Deduplicate, sort by **unresolved** / recent first when the API allows. If you cannot tell resolved state, note that limitation.

## Comment authorship

- **Comments by the user** on **their own** PR (same GitHub login as PR author, or explicitly identified by the user): treat with the **self-comment prefix convention** below.
- **Everyone else**: do **not** assume a prefix pattern. Summarize intent, propose a **draft reply in chat** (if a reply is needed), and **debate tradeoffs** with the user before any GitHub post. If they request code changes, same as `TODO:`: **branch check** + **explicit authorization** before editing; never commit without being asked.

## Self-comment prefix convention (user’s notes to the agent on their PR)

Only apply when the comment is **from the user** on **their** PR. Parse the **first line** or leading token:

| Prefix | Meaning | Agent behavior |
|--------|---------|------------------|
| `Q:` | Question | Answer in **this chat**. Cite code/paths. If unclear, ask one short follow-up. **Do not** post to GitHub unless asked. |
| `R:` | Review / validate | Check implementation against code, docs, and task acceptance criteria. May include: style/patterns, correctness, **on-chain or explorer validation** (e.g. config contract addresses — use RPC/etherscan-style verification when feasible). Report findings in **this chat**. If something should be fixed, describe it and wait for **explicit authorization** before editing files. |
| `TODO:` | Requested change | Propose the concrete change (files, rationale). Use judgment: if the TODO is wrong or harmful, say so in chat and suggest a better approach. **Do not edit** until the user explicitly authorizes applying changes (and branch check passes). |
| `NIT:` | Nitpick / optional | Low priority; describe the optional tweak in chat; **edit only** after explicit authorization. |
| `BLOCK:` | Must fix before merge | Same as TODO but flag merge-blocking; still **no edits** without authorization and correct branch. |
| `CTX:` | Need context | User is leaving a breadcrumb — expand from codebase/docs; answer in chat. |
| `ALT:` | Consider alternative | Research options briefly; recommend one path in chat; **no code edits** without explicit authorization. |

If a comment has **no prefix**, infer intent from wording: question → like `Q:`; “please change” → like `TODO:`; “double-check” → like `R:`.

## Workflow per comment (and batch)

For each comment (or grouped thread):

1. **Quote** a short excerpt + file/line if inline.
2. **Classify** (self vs other; prefix if self).
3. **Act**: answer or validate in chat; for patches, **propose** changes and obtain **explicit authorization** (and **branch check**) before editing files.
4. **Summarize** what changed (files touched) or what still needs a human decision.
5. **Draft GitHub reply** (optional): only in chat, **unless** the user explicitly ordered posting.

For **other people’s** comments: add a **“Suggested reply (draft, not posted)”** block when useful, and flag anything that needs product/protocol decision.

## Validation examples (for `R:` and similar)

- **Config addresses** (`src/data.ts`, `ponder.config.ts`): compare to chain docs, repo reference docs, and when possible **on-chain** code/name or **explorer** verification; state confidence (confirmed / likely / unverified).
- **Behavior**: point to handlers, schema, tests; run `pnpm typecheck`, `pnpm lint`, targeted tests if they exist.

## Output shape in chat

Use clear sections:

- **PR**: number, title, link  
- **Comments processed** (ordered)  
- **Answers / validation** (per item)  
- **Proposed code changes** (summary + paths; note if **applied** after authorization or still **pending**)  
- **Draft PR replies** (clearly labeled, not posted)  
- **Open questions** for the user  

## Optional: other use cases to suggest over time

- **`FYI:`** — no action; acknowledge only (useful for paper trail).  
- **`SPIKE:`** — time-boxed research; output options + recommendation in chat; **no file edits** without authorization.  
- **`TEST:`** — run read-only checks in chat when possible; **adding or changing tests** requires explicit authorization and branch check.  
- **`DOCS:`** — propose doc edits in chat; **apply** only after authorization.

The user can extend this table in this file as the team agrees on more prefixes.
