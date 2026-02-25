# Commit Changes

Create git commits for session changes.

## Git Safety Protocol

### NEVER Without Permission

- Update git config
- Force push to main/master
- Skip hooks (--no-verify)
- Amend without checking authorship

### Check Before Amending

```bash
git log -1 --format='%an %ae'  # Check authorship
git status  # Ensure "Your branch is ahead"
```

## Workflow

### 1. Analyze Changes (parallel)

```bash
git status
git diff
git log -3 --oneline
```

### 2. Plan Commits

- Group related files
- Draft messages (imperative mood)
- Focus on WHY, not WHAT

### 3. Present Plan

"I plan to create [N] commit(s):

- Files: [list]
- Message: [message]
  Shall I proceed?"

### 4. Execute on Confirmation

```bash
git add [specific files]  # Never use -A or .
git commit -m "Message"
git log --oneline -n 3
```

## Important

✗ NO co-author attribution
✗ NO "Generated with Claude"
✗ NO "Co-Authored-By" lines
✓ Write as if user wrote them
✓ Keep commits atomic
✓ Handle pre-commit hooks if they modify files
