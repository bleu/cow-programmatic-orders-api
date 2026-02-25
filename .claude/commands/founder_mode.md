# Founder Mode - Retroactive Process Setup

You're working on an experimental feature that didn't get the proper ticketing and PR setup. This command helps you retroactively apply proper process to work that's already been implemented.

## SSR Principles

- **Simple**: Follow the standard workflow steps, just in reverse order
- **Systematic**: Complete each step fully before moving to the next
- **Reliable**: Validate git state and commits before any branch operations

## Critical Checks

- [ ] Recent commit exists and contains the experimental work
- [ ] Commit is on main branch and needs to be moved to feature branch
- [ ] Linear ticket creation includes clear problem statement (not just implementation)
- [ ] Git operations preserve commit history correctly
- [ ] PR creation follows standard process

## Workflow Steps

**Prerequisites**: You should have just made a commit with experimental work.

### 1. Capture Current State

```bash
# Get the SHA of your recent commit
git log --oneline -1
# Verify you're on main branch
git branch --show-current
```

### 2. Create Retroactive Linear Ticket

- Read `.claude/commands/linear.md` for full instructions
- Think deeply about what problem you solved (not just what you implemented)
- Create ticket with proper problem statement and proposed solution
- Set state to 'In Dev' since work is already complete
- Must include headers: "### Problem to Solve" and "### Proposed Solution"

### 3. Git Branch Management

```bash
# Get recommended branch name from Linear ticket
git checkout main
git checkout -b 'BRANCHNAME'
git cherry-pick 'COMMITHASH'
git push -u origin 'BRANCHNAME'
```

### 4. Create Pull Request

```bash
gh pr create --fill
```

### 5. Complete PR Description

- Read `.claude/commands/describe_pr.md` and follow instructions
- Ensure description reflects the retroactive nature of the work

## Git Safety

- Always verify commit SHA before cherry-picking
- Confirm you're on correct branch before each git operation
- Check that cherry-pick was successful before pushing
- Validate remote branch creation before creating PR

## Quality Gates

- Linear ticket must have clear problem statement (not just "implement X")
- Commit message should be descriptive of the change
- Branch name should follow team conventions
- PR description should be complete and follow template
