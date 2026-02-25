#!/bin/bash
# setup_repo.sh - Initialize a new project with claude-boilerplate

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

echo "Setting up project with claude-boilerplate..."

# Create directory structure
echo "Creating directory structure..."
mkdir -p thoughts/{plans,research,analysis,tickets}
mkdir -p agent_docs

# Copy .claude folder if it doesn't exist
if [ ! -d ".claude" ]; then
    echo "Copying .claude folder..."
    cp -r "$REPO_ROOT/.claude" .
else
    echo ".claude folder already exists, skipping..."
fi

# Copy .github folder if it doesn't exist
if [ ! -d ".github" ]; then
    echo "Copying .github templates..."
    cp -r "$REPO_ROOT/.github" .
else
    echo ".github folder already exists, skipping..."
fi

# Copy hack folder if it doesn't exist
if [ ! -d "hack" ]; then
    echo "Copying hack scripts..."
    cp -r "$REPO_ROOT/hack" .
else
    echo "hack folder already exists, skipping..."
fi

# Create template CLAUDE.md if it doesn't exist
if [ ! -f "CLAUDE.md" ]; then
    echo "Creating template CLAUDE.md..."
    cat > CLAUDE.md << 'EOF'
# CLAUDE.md

## What This Project Is

[1-3 sentence description of the project's purpose]

**Tech**: [framework], [language], [database], [package manager]

## Architecture

[Brief architecture description]

**Key paths**:
- `src/` - Source code
- `tests/` - Test files

## How to Verify Changes

```bash
# Build the project
[build command]

# Run tests
[test command]

# Check code style
[lint command]
```

## Reference Documentation

Read these files when relevant to your task:

| File | When to read |
|------|--------------|
| `agent_docs/[file].md` | [trigger condition] |

## Working Conventions

- Save analysis, plans, and reasoning to `thoughts/` directory
- Follow existing code patterns - the codebase is the source of truth for style
EOF
else
    echo "CLAUDE.md already exists, skipping..."
fi

# Create .gitignore additions if needed
if [ -f ".gitignore" ]; then
    if ! grep -q "thoughts/private" .gitignore 2>/dev/null; then
        echo "" >> .gitignore
        echo "# Private thoughts (not committed)" >> .gitignore
        echo "thoughts/private/" >> .gitignore
    fi
fi

echo ""
echo "Setup complete!"
echo ""
echo "Next steps:"
echo "1. Update CLAUDE.md with your project details"
echo "2. Run /init_claude_md to customize further"
echo "3. Add project-specific patterns to .claude/commands/"
