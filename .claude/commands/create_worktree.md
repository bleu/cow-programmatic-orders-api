# Create Worktree

Create a new git worktree for isolated development work with proper safety protocols.

## Safety Protocols

**CRITICAL SAFETY CHECKS - NEVER SKIP:**

1. Verify base branch (main/develop) is clean and up-to-date
2. Confirm tests/typecheck passes on base branch before creating worktree
3. Validate worktree setup completes successfully

## Workflow

### 1. Pre-flight Safety Checks

First, verify the repository state:

```bash
# Check current status
git status

# Ensure we're on the base branch and it's clean
git checkout main  # or develop
git pull origin main

# Verify tests pass on base branch (adjust command to your project)
# npm test || echo "❌ Tests failing on base branch - fix before creating worktree"
```

**IMPORTANT:** If any of these checks fail, DO NOT proceed. Fix issues first.

### 2. Gather Required Information

Before creating the worktree, collect:

- **Ticket ID** (e.g., TICKET-123) - if applicable
- **Descriptive branch name** (e.g., feat/add-user-authentication)
- **Plan file path** (relative path from project root) - if applicable

### 3. Create Worktree

```bash
# Create worktree directory
BRANCH_NAME="feat/your-feature-name"
PROJECT_NAME=$(basename $(pwd))
WORKTREE_PATH="../${PROJECT_NAME}-${BRANCH_NAME}"

# Create new branch and worktree
git worktree add -b "$BRANCH_NAME" "$WORKTREE_PATH" main
```

**Examples:**

```bash
# Create feature branch worktree
git worktree add -b feat/user-auth ../myproject-user-auth main

# Create fix branch worktree
git worktree add -b fix/login-bug ../myproject-login-fix main
```

### 4. Setup Worktree

After creating the worktree:

```bash
cd "$WORKTREE_PATH"

# Copy environment files (adjust paths to your project)
cp ../original-project/.env .env

# Install dependencies (adjust to your package manager)
npm install  # or pnpm install, yarn, etc.

# Verify setup
npm test  # or your project's verification command
```

### 5. Navigate to Worktree

```bash
# Navigate to the worktree
cd "$WORKTREE_PATH"

# Verify you're in the worktree
git branch --show-current  # Should show your new branch
pwd                        # Should show worktree path
```

### 6. Begin Development

The worktree is now ready for isolated development:

- Separate working directory
- Own dependencies after install
- Can run services independently
- Ready for implementation

## Important Path Notes

**Thoughts Directory:**

- The `thoughts/` directory exists in each worktree
- Use relative paths starting with `thoughts/...`
- Example: `thoughts/plans/implement-feature.md`

## Error Recovery

**If worktree creation fails:**

1. Check the error message
2. Verify base branch passes tests
3. Ensure you have write permissions to the parent directory
4. Check available disk space

**If you need to clean up manually:**

```bash
# Remove worktree
git worktree remove --force "$WORKTREE_PATH"

# Delete the branch (if needed)
git branch -D "$BRANCH_NAME"

# Prune stale worktree references
git worktree prune
```

## Best Practices

**DO:**

- Always create worktrees from a clean, tested base branch
- Use descriptive branch names (feat/, fix/, refactor/)
- Copy necessary .env files before running
- Verify worktree setup completes successfully

**DON'T:**

- Skip the pre-flight safety checks
- Create worktrees from broken branches
- Share database connections between worktrees running simultaneously
- Force worktree creation if setup fails

## Integration with Implementation

After worktree creation, you can:

1. Navigate to the worktree
2. Run `/create_plan` to create an implementation plan
3. Follow normal development workflow in isolation
4. Create commits and PRs from the worktree
5. Clean up when work is complete

The worktree provides complete isolation for parallel development.
