#!/bin/bash
# create_worktree.sh - Create a git worktree for isolated development

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

usage() {
    echo "Usage: $0 <branch-name> [base-branch]"
    echo ""
    echo "Arguments:"
    echo "  branch-name    Name of the new branch (e.g., feat/add-feature)"
    echo "  base-branch    Base branch to create from (default: main)"
    echo ""
    echo "Examples:"
    echo "  $0 feat/user-auth"
    echo "  $0 fix/login-bug develop"
    exit 1
}

if [ -z "$1" ]; then
    usage
fi

BRANCH_NAME="$1"
BASE_BRANCH="${2:-main}"
PROJECT_NAME=$(basename "$(pwd)")
WORKTREE_PATH="../${PROJECT_NAME}-${BRANCH_NAME//\//-}"

echo -e "${YELLOW}Creating worktree for branch: $BRANCH_NAME${NC}"
echo "Base branch: $BASE_BRANCH"
echo "Worktree path: $WORKTREE_PATH"
echo ""

# Pre-flight checks
echo -e "${YELLOW}Running pre-flight checks...${NC}"

# Check if base branch exists
if ! git show-ref --verify --quiet "refs/heads/$BASE_BRANCH"; then
    echo -e "${RED}Error: Base branch '$BASE_BRANCH' does not exist${NC}"
    exit 1
fi

# Check for uncommitted changes
if [ -n "$(git status --porcelain)" ]; then
    echo -e "${YELLOW}Warning: You have uncommitted changes${NC}"
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Update base branch
echo "Updating base branch..."
git fetch origin "$BASE_BRANCH"
git checkout "$BASE_BRANCH"
git pull origin "$BASE_BRANCH"

# Create worktree
echo -e "${YELLOW}Creating worktree...${NC}"
git worktree add -b "$BRANCH_NAME" "$WORKTREE_PATH" "$BASE_BRANCH"

# Copy environment files if they exist
echo "Setting up worktree..."
cd "$WORKTREE_PATH"

# Common env files to copy
for envfile in .env .env.local .env.development; do
    if [ -f "../$PROJECT_NAME/$envfile" ]; then
        cp "../$PROJECT_NAME/$envfile" .
        echo "Copied $envfile"
    fi
done

echo ""
echo -e "${GREEN}Worktree created successfully!${NC}"
echo ""
echo "To start working:"
echo "  cd $WORKTREE_PATH"
echo ""
echo "To install dependencies (if needed):"
echo "  npm install  # or pnpm install, yarn, etc."
echo ""
echo "When finished, clean up with:"
echo "  git worktree remove $WORKTREE_PATH"
