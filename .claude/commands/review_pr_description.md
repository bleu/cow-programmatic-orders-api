# Review PR Title and Description

You are tasked with reviewing a pull request title and description against the context that produced the plan, especially when planning and implementation happened in separate chats. This is a PR communication review, not a code review.

The goal is to verify whether the PR title and description preserve the original reasoning: what problem or feature goal motivated the work, which solution was chosen, which alternatives were considered, what trade-offs matter, and whether the implementation still matches the plan's intent.

## Core Principle

This command exists to catch context loss between `/create_plan`, `/implement_plan`, `/describe_pr`, and the final PR presentation.

Focus on whether a human reviewer can validate:

- The PR title accurately frames the change without overselling it
- The problem, feature goal, or architectural need behind the PR is clear
- The selected approach and why it was chosen are explained
- Important alternatives that were discussed but not chosen are mentioned when useful
- Meaningful deviations between the plan and implementation are called out
- Risks, assumptions, follow-up work, and larger-plan context are visible
- Local-only context was converted into reviewer-accessible explanation

Do not perform a traditional code review unless the user explicitly asks for one. You may inspect the diff only to validate whether the title and description match the actual PR.

## Style Reference

Before drafting title or description changes, read `.claude/reference/tropes.md` if it exists.

Use it as a writing-quality checklist, not as a factual source. The suggested PR text should sound like a clear human wrote it: specific, plain, and proportional to the change. Avoid AI-ish filler, inflated stakes, dramatic reframes, excessive bold-first bullets, and repetitive summaries.

## Hard Rules

1. **Default to chat-only review.** Do not update the PR title, PR body, post GitHub comments, post Linear comments, or edit code unless the user explicitly asks.
2. **Never invent planning context.** If the plan, transcript, or decision history is missing, say what is missing and ask for it.
3. **Do not cite local-only files in the proposed PR description** unless reviewers can access them. Summarize the context instead.
4. **Do not include code snippets in reasoning sections** of the PR description. Use code references only when needed to ground a factual claim.
5. **If the current title and description are already good, say so clearly** and only suggest targeted improvements.
6. **If the implementation intentionally diverged from the plan, distinguish that from an error.** Ask the user if the reason for the divergence is not documented.

## Inputs

The user may invoke this command with any combination of:

- PR number or URL
- Branch name
- Plan path, usually under `thoughts/plans/`
- Ticket path, usually under `thoughts/tickets/`
- Planning transcript id or chat reference
- Notes, Linear issue, Slack summary, or other decision context

If no useful context is provided, resolve the PR first, then ask for the missing plan or planning-chat context before judging whether the "why" is complete.

## Workflow

### 1. Resolve the PR

1. If the user passed a PR number or URL, use it.
2. Else if they passed a branch name, find the open PR:
   `gh pr list --head "<branch>" --state open --json number,title,url,headRefName,baseRefName`
3. Else try the current branch:
   `gh pr view --json number,title,url,state,author,headRefName,baseRefName`
4. If no PR is found, list open PRs:
   `gh pr list --state open --limit 30 --json number,title,headRefName,author`
   and ask which one to review.

If `gh` fails because of auth or repository configuration, tell the user what failed and stop.

### 2. Gather PR Evidence

Collect:

- Current PR title and body:
  `gh pr view <number> --json title,body,number,url,state,headRefName,baseRefName`
- Full PR diff:
  `gh pr diff <number>`
- Commit history:
  `gh pr view <number> --json commits`
- Review comments when relevant:
  `gh pr view <number> --comments`

Read files referenced by the PR description, plan, or diff only when needed to validate communication accuracy. This command is about title/description alignment, not exhaustive implementation review.

### 3. Gather Planning Context

Use the strongest available context, in this order:

1. Explicit plan path provided by the user
2. Plan path linked in the PR body, ticket, branch name, or commits
3. Ticket or research docs referenced by the plan
4. Planning transcript id or chat reference provided by the user
5. Existing notes the user explicitly points to

When a plan path is provided:

- Read it completely
- Read the original ticket and research documents referenced by the plan
- Extract the original problem, desired end state, chosen approach, alternatives, explicit non-goals, risks, phases, and success criteria

When a planning transcript is provided:

- Read the transcript enough to extract decisions and corrections from the user
- Prefer user-stated intent and final agreed decisions over early exploratory hypotheses
- Summarize the relevant planning context; do not include transcript implementation details in the PR body unless they help reviewers validate reasoning

If the user references "the planning chat" but does not provide a plan path, transcript id, or link, ask for the relevant plan file or transcript reference before making strong claims about missing context.

### 4. Compare Title, Description, Plan, and Implementation

Evaluate the current PR title and description against the planning context:

- **Title accuracy**: Does the title communicate the actual change at the right level of specificity?
- **Title tone**: Is the title concise, factual, and free from inflated claims?
- **Problem / goal**: Does the description explain the previous state or feature goal accurately?
- **Chosen approach**: Does it explain why this approach was selected?
- **Alternatives**: Are meaningful rejected options mentioned briefly, when they matter?
- **Implementation alignment**: Does the implementation appear to match the plan's intent?
- **Plan deviations**: Are deviations from the plan explained, or should they be added?
- **Scope boundaries**: Are non-goals and follow-up work clear enough?
- **Foundation work**: If this PR enables future PRs, is that made explicit?
- **Verification**: Are tests, linting, manual checks, and known gaps represented accurately?
- **Reviewer accessibility**: Does the description avoid references to local-only files, private notes, or unavailable context?
- **Writing quality**: Does the text avoid the AI writing tropes listed in `.claude/reference/tropes.md`?

Do not require every section for every PR. Apply judgment. Small PRs can have a short description, but the title and "why" should still be understandable.

### 5. Output Review in Chat

Use this shape:

```markdown
## PR Title/Description Review

PR: #<number> <title>
Plan/context used: <plan path, ticket, transcript, or "not provided">

## Verdict

[One short paragraph: good as-is, needs targeted improvements, or missing important context.]

## Findings

- [High-signal issue or missing context, with why it matters]
- [Another issue, if any]

## Suggested Title

[Only include if the current title should change. Otherwise say "No change suggested."]

## Suggested Description Changes

[Provide replacement sections or a concise patch-style rewrite. Focus on Context, Chosen Approach, Alternatives, Reviewer Notes, and Verification.]

## Questions Before Updating

- [Only ask questions that block a correct title/body update]
```

If there are no issues, say that clearly and mention any residual uncertainty from missing context or unrun verification.

### 6. Updating the PR

Only update the PR title or body if the user explicitly asks you to apply/update/post the changes.

Before updating:

1. Confirm the PR number and URL in chat.
2. Preserve any required repository template sections unless the user approved changing structure.
3. Use a heredoc or body file, never unsafe inline shell interpolation.

Examples:

```bash
gh pr edit <number> --title "Clear factual title"

gh pr edit <number> --body "$(cat <<'EOF'
[updated description]
EOF
)"
```

After updating, confirm the command succeeded and summarize what changed.

## When To Ask About External Comments

If important context is too detailed for the PR body but useful for the record, ask whether the user wants a separate comment somewhere reviewer-accessible, such as:

- Linear comment with deeper decision history
- GitHub PR comment with additional rationale
- Internal doc or handoff note

Do not post any external comment without explicit user approval.

## Quality Gates

- The review compares the PR title/body against actual PR diff and planning context
- The command does not behave like a code review unless explicitly requested
- Missing "why" is called out before implementation details
- Suggested edits are human-readable and avoid code snippets
- Suggested edits avoid common AI writing tropes from `.claude/reference/tropes.md`
- Local-only references are summarized or removed
- The selected approach is explained more deeply than rejected alternatives
- Open questions are limited to decisions that cannot be inferred from available context
- No PR title, PR body, or external comment is changed without explicit approval
