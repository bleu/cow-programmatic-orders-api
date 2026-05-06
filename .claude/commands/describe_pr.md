# Generate PR Description

You are tasked with generating a human-centered pull request description that helps reviewers validate the context, reasoning, and decisions behind the PR. The description should make it easy for a human to confirm whether the AI correctly understood the problem, selected a coherent solution, and preserved the intended direction of the work.

## SSR Principles

- **Simple**: Prefer clear human reasoning over exhaustive implementation inventory
- **Systematic**: Complete all sections thoroughly before moving to next
- **Reliable**: Validate each step and run all possible verification commands

## Critical Checks

- [ ] PR exists and can be accessed via GitHub CLI
- [ ] All verification commands run successfully or are documented as failed
- [ ] Description matches actual changes in the diff
- [ ] Description explains the problem/context and chosen solution when applicable
- [ ] Local-only references are either avoided or explicitly converted into reviewer-accessible context
- [ ] Breaking changes are clearly highlighted

## Description Philosophy

The PR description is not a code review and should not read like a file-by-file changelog. It is a document for humans to validate the logic of the change.

Focus on:

- The previous state or problem that motivated the PR, when applicable
- The user, product, operational, or architectural need the PR is trying to address
- The solution options that were considered
- The option that was chosen and why it fits the constraints
- The trade-offs, assumptions, and follow-up plan that reviewers should validate
- How this PR fits into a larger sequence of work, if it is foundational for later PRs

Keep non-chosen options short: one bullet or one to two sentences each is enough. Spend most of the explanation on the selected approach and the reasoning behind it.

For feature work, there may not be a bug or "problem" in the strict sense. In that case, describe the feature goal, the capability being introduced, the constraints that shaped the implementation, and the logic behind the chosen design.

Avoid code snippets in the reasoning sections. Include diagrams only when they clarify system flow, decision structure, or how this PR enables future work.

Be careful with references to files, notes, or documents that exist only locally. Do not cite local-only artifacts as if reviewers can access them. If important context lives locally, summarize the relevant context in the PR description or ask the user whether to post additional detail somewhere reviewer-accessible, such as a Linear comment.

## Workflow Steps

1. **Check for a PR description template:**
   - Look for a PR description template under `thoughts/shared/` (local) or similar
   - If a template exists, evaluate whether it supports the human-centered description goals above
   - If the template is useful but incomplete, follow the relevant parts and adapt the rest to include context, chosen approach, alternatives, and reviewer notes
   - If the template conflicts with the kind of PR being described or would produce a weaker human review artifact, ask the user whether to follow the template strictly or use a better structure for this PR
   - If no template exists, use the default format below

2. **Identify the PR to describe:**
   - Check if the current branch has an associated PR: `gh pr view --json url,number,title,state 2>/dev/null`
   - If no PR exists for the current branch, or if on main/master, list open PRs: `gh pr list --limit 10 --json number,title,headRefName,author`
   - Ask the user which PR they want to describe

3. **Gather comprehensive PR information:**
   - Get the full PR diff: `gh pr diff {number}`
   - If you get an error about no default remote repository, instruct the user to run `gh repo set-default` and select the appropriate repository
   - Get commit history: `gh pr view {number} --json commits`
   - Review the base branch: `gh pr view {number} --json baseRefName`
   - Get PR metadata: `gh pr view {number} --json url,title,number,state`

4. **Analyze the changes thoroughly:**
   - Read through the entire diff carefully
   - For context, read any files that are referenced but not shown in the diff
   - Understand the purpose, impact, and reasoning behind each meaningful change
   - Identify user-facing changes vs internal implementation details
   - Infer the problem or feature goal that motivated the PR
   - Identify any solution alternatives that appear to have been considered from commits, comments, docs, discussions, or surrounding code
   - If the selected approach is unclear, ask the user for context before writing the final description
   - If key decision context exists only in local notes or private files, summarize it without referencing inaccessible paths, or ask the user whether to publish that context elsewhere
   - Look for breaking changes or migration requirements

5. **Handle verification requirements:**
   - For each verification step:
     - If it's a command you can run (like `make test`, `npm test`, etc.), run it
     - If it passes, mark the checkbox as checked: `- [x]`
     - If it fails, keep it unchecked and note what failed: `- [ ]` with explanation
     - If it requires manual testing, leave unchecked and note for user
   - Document any verification steps you couldn't complete

6. **Generate the description:**
   - Fill out each section as a human decision document:
     - Be specific about the problem, feature goal, or context that motivated the PR
     - Explain the selected solution and why it was chosen
     - Mention rejected alternatives briefly, if known and useful
     - Focus technical detail on validating the reasoning, not reviewing code line-by-line
     - Note larger rollout plans, follow-up PRs, or foundational intent when relevant
     - Include diagrams only when they materially improve understanding
   - Ensure all checklist items are addressed (checked or explained)

7. **Update the PR:**
   - Update the PR description directly: `gh pr edit {number} --body "$(cat <<'EOF'
   [description content]
   EOF
   )"`
   - Confirm the update was successful
   - If any verification steps remain unchecked, remind the user to complete them before merging

## Default PR Description Template

If no custom template exists, use this format:

```markdown
## Context

[Describe the previous state, problem, feature goal, or architectural need this PR addresses. If this is a feature rather than a fix, describe the capability being introduced and why it matters.]

## Chosen Approach

[Explain the solution that was implemented and why it fits the constraints. Keep this focused on the reasoning a reviewer should validate, not on code-level walkthrough.]

## Alternatives Considered

- [Alternative considered, if applicable, and why it was not chosen. Keep short.]
- [Another alternative, if applicable.]

If no meaningful alternatives were considered or discovered, write `None documented`.

## What Changed

- [High-level behavioral, product, architectural, or operational change]
- [Another meaningful change]

## Reviewer Notes

[Call out assumptions, trade-offs, risks, diagrams, or how this PR supports a larger sequence of work. Do not include code snippets here.]

## How to Test

1. [Step-by-step testing instructions]
2. [Another step]

## Checklist

- [ ] Tests pass
- [ ] Linting passes
- [ ] Documentation updated (if needed)
- [ ] Problem/context and chosen approach are explained
- [ ] Local-only references are avoided or summarized
- [ ] Breaking changes documented (if any)

## Breaking Changes

[List any breaking changes, or "None" if not applicable]

## Related Issues

[Link to related issues/tickets, or "None"]
```

## Git Safety

- Always confirm PR number before making changes
- Use `--body-file` or heredoc instead of inline text to avoid shell injection
- Verify `gh` commands succeed before proceeding to next step

## Quality Gates

- Description must address all template sections
- Verification commands must either pass or be documented as manual-only
- Description must help a human validate the AI's understanding and decision logic
- Chosen solution must be explained more deeply than rejected alternatives
- Rejected alternatives must stay concise and should not dominate the PR description
- Reasoning sections must not include code snippets
- Local-only references must not be cited as reviewer-accessible sources
- Breaking changes must be in dedicated section if present
- Related issues/tickets must be properly linked

## Important Notes

- This command works across different repositories - always check for local templates first
- Be thorough but concise - descriptions should be scannable
- Focus on the "why" and decision logic more than the "what"
- Avoid a file-by-file changelog unless the repository template explicitly requires one
- Include any breaking changes or migration notes prominently
- If the PR touches multiple components, organize the description accordingly
- If the PR is part of a larger plan, explain where it sits in that plan and what follows
- If key context is missing, ask the user targeted questions before updating the PR
- Always attempt to run verification commands when possible
- Clearly communicate which verification steps need manual testing
