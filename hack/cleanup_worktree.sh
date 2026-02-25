#!/bin/bash
# cleanup_worktree.sh - Clean up a git worktree

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

usage() {
    echo "Usage: $0 <worktree-path> [--delete-branch]"
    echo ""
    echo "Arguments:"
    echo "  worktree-path    Path to the worktree to remove"
    echo "  --delete-branch  Also delete the associated branch"
    echo ""
    echo "Examples:"
    echo "  $0 ../myproject-feat-user-auth"
    echo "  $0 ../myproject-feat-user-auth --delete-branch"
    exit 1
}

if [ -z "$1" ]; then
    usage
fi

WORKTREE_PATH="$1"
DELETE_BRANCH=false

if [ "$2" == "--delete-branch" ]; then
    DELETE_BRANCH=true
fi

# Check if worktree exists
if ! git worktree list | grep -q "$WORKTREE_PATH"; then
    echo -e "${RED}Error: Worktree '$WORKTREE_PATH' not found${NC}"
    echo ""
    echo "Available worktrees:"
    git worktree list
    exit 1
fi

# Get branch name before removing worktree
BRANCH_NAME=$(cd "$WORKTREE_PATH" 2>/dev/null && git branch --show-current)

echo -e "${YELLOW}Removing worktree: $WORKTREE_PATH${NC}"

# Check for uncommitted changes in worktree
if [ -d "$WORKTREE_PATH" ] && [ -n "$(cd "$WORKTREE_PATH" && git status --porcelain)" ]; then
    echo -e "${YELLOW}Warning: Worktree has uncommitted changes${NC}"
    read -p "Force remove anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
    git worktree remove --force "$WORKTREE_PATH"
else
    git worktree remove "$WORKTREE_PATH"
fi

echo -e "${GREEN}Worktree removed${NC}"

# Optionally delete the branch
if [ "$DELETE_BRANCH" = true ] && [ -n "$BRANCH_NAME" ]; then
    echo -e "${YELLOW}Deleting branch: $BRANCH_NAME${NC}"

    # Check if branch is merged
    if git branch --merged | grep -q "$BRANCH_NAME"; then
        git branch -d "$BRANCH_NAME"
    else
        echo -e "${YELLOW}Warning: Branch '$BRANCH_NAME' is not merged${NC}"
        read -p "Force delete anyway? (y/N) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            git branch -D "$BRANCH_NAME"
        fi
    fi
fi

# Prune stale worktree references
git worktree prune

echo ""
echo -e "${GREEN}Cleanup complete!${NC}"
