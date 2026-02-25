# hack/ Scripts

Utility scripts for development workflow automation.

## Scripts

| Script | Purpose |
|--------|---------|
| `setup_repo.sh` | Initialize a new project with claude-boilerplate |
| `create_worktree.sh` | Create a git worktree for isolated development |
| `cleanup_worktree.sh` | Clean up a git worktree |
| `run_silent.sh` | Run commands silently, only show output on failure |
| `port-utils.sh` | Utilities for managing ports (check, kill, wait) |

## Usage

```bash
# Make scripts executable (if needed)
chmod +x hack/*.sh

# Setup a new project
./hack/setup_repo.sh

# Create a worktree for feature development
./hack/create_worktree.sh feat/my-feature main

# Clean up worktree when done
./hack/cleanup_worktree.sh ../myproject-feat-my-feature --delete-branch

# Check/kill ports
./hack/port-utils.sh check 3000
./hack/port-utils.sh kill 3000
```

## Adding New Scripts

When adding scripts to this directory:

1. Use `.sh` extension for bash scripts
2. Include a header comment explaining purpose
3. Use `set -e` for error handling
4. Add color output for better UX
5. Include usage/help function
6. Update this CLAUDE.md with the new script
