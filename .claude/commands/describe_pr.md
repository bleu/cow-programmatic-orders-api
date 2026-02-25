# Generate PR Description

You are tasked with generating a comprehensive pull request description following the repository's standard template.

## SSR Principles

- **Simple**: Follow the established template format exactly
- **Systematic**: Complete all sections thoroughly before moving to next
- **Reliable**: Validate each step and run all possible verification commands

## Critical Checks

- [ ] PR exists and can be accessed via GitHub CLI
- [ ] All verification commands run successfully or are documented as failed
- [ ] Description matches actual changes in the diff
- [ ] Breaking changes are clearly highlighted

## Workflow Steps

1. **Check for a PR description template:**
   - Look for `thoughts/shared/pr_description.md` or similar template
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
   - Understand the purpose and impact of each change
   - Identify user-facing changes vs internal implementation details
   - Look for breaking changes or migration requirements

5. **Handle verification requirements:**
   - For each verification step:
     - If it's a command you can run (like `make test`, `npm test`, etc.), run it
     - If it passes, mark the checkbox as checked: `- [x]`
     - If it fails, keep it unchecked and note what failed: `- [ ]` with explanation
     - If it requires manual testing, leave unchecked and note for user
   - Document any verification steps you couldn't complete

6. **Generate the description:**
   - Fill out each section thoroughly:
     - Be specific about problems solved and changes made
     - Focus on user impact where relevant
     - Include technical details in appropriate sections
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
## Summary

[1-3 sentence summary of what this PR does and why]

## Changes

- [List of specific changes made]
- [Another change]

## How to Test

1. [Step-by-step testing instructions]
2. [Another step]

## Checklist

- [ ] Tests pass
- [ ] Linting passes
- [ ] Documentation updated (if needed)
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
- Breaking changes must be in dedicated section if present
- Related issues/tickets must be properly linked

## Important Notes

- This command works across different repositories - always check for local templates first
- Be thorough but concise - descriptions should be scannable
- Focus on the "why" as much as the "what"
- Include any breaking changes or migration notes prominently
- If the PR touches multiple components, organize the description accordingly
- Always attempt to run verification commands when possible
- Clearly communicate which verification steps need manual testing
