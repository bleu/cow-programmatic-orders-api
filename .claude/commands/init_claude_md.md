# Initialize CLAUDE.md

**Purpose**: Create well-crafted CLAUDE.md files following best practices from HumanLayer research.
**Context**: This command helps bootstrap CLAUDE.md files that are concise, actionable, and high-leverage.

## Core Principles (from HumanLayer Research)

1. **LLMs are stateless** - CLAUDE.md enters every conversation, so it must be universally applicable
2. **Minimize instructions** - Aim for <300 lines, ideally ~60 lines. More instructions = diluted quality
3. **Progressive disclosure** - Reference separate docs (agent_docs/) instead of embedding everything
4. **Never use LLMs as linters** - Don't include code style rules; use actual linters
5. **Manual craft over auto-generation** - CLAUDE.md is high-leverage; every line matters

## Initial Response

When this command is invoked:

1. **If in an existing project with CLAUDE.md**, respond:

```
I see this project already has a CLAUDE.md file. Would you like me to:
1. Review and improve the existing CLAUDE.md based on best practices
2. Create a fresh CLAUDE.md (will backup the existing one)
3. Create CLAUDE.md files for subdirectories/packages
4. Customize the .claude commands for this project

Which option would you prefer?
```

2. **If no CLAUDE.md exists**, respond:

```
I'll help create a CLAUDE.md file following best practices for maximum effectiveness.

First, let me analyze the codebase to understand:
- What: Tech stack, architecture, key paths
- Why: Project purpose and component roles
- How: Build, test, and verification commands

I'll then ask a few targeted questions before writing the file.
```

Then proceed with the research phase.

## Process Steps

### Step 1: Codebase Analysis

Spawn parallel research tasks to understand:

1. **Project structure** - Use codebase-locator to find:
   - Package manager (package.json, Cargo.toml, go.mod, etc.)
   - Build configuration files
   - Entry points and main directories
   - Test configuration

2. **Tech stack detection** - Analyze:
   - Languages used
   - Frameworks and major dependencies
   - Database/storage systems
   - External services

3. **Existing documentation** - Check for:
   - README.md files
   - docs/ or documentation/ directories
   - Existing CLAUDE.md or similar files
   - agent_docs/ directory

4. **Build/test commands** - Find:
   - Build scripts in package.json/Makefile/etc.
   - Test commands
   - Lint/format commands
   - CI configuration

### Step 2: Interactive Clarification

After research, ask targeted questions:

```
Based on my analysis, here's what I found:

**Tech Stack**: [detected stack]
**Project Type**: [web app, CLI, library, etc.]
**Key Directories**: [main paths]

Before I write the CLAUDE.md, I need to understand:

1. What is the primary purpose of this project in 1-2 sentences?
2. Are there any specific conventions or patterns unique to this codebase?
3. What commands do you use most frequently for development?
4. Should I create an agent_docs/ directory for detailed documentation?
5. Do you want me to customize the .claude commands for this project?
```

### Step 3: Structure Planning

Based on responses, plan the CLAUDE.md structure:

**Required sections** (always include):
- What This Project Is (1-3 sentences)
- Tech stack summary (1 line)
- Architecture overview (brief diagram or description)
- How to Verify Changes (essential commands only)

**Optional sections** (include if relevant):
- Key Paths (for monorepos or complex structures)
- Reference Documentation (pointers to agent_docs/)
- Working Conventions (only universally applicable ones)

### Step 4: Write CLAUDE.md

Use this template as a starting point, adapting to the project:

```markdown
# CLAUDE.md

## What This Project Is

[1-3 sentence description of the project's purpose]

**Tech**: [framework], [language], [database], [package manager]

## Architecture

[Brief architecture description or ASCII diagram - keep under 10 lines]

**Key paths**:
- `path/` - Description
- `path/` - Description

## How to Verify Changes

```bash
[build command]      # Build the project
[test command]       # Run tests
[lint command]       # Check code style
```

## Reference Documentation

Read these files when relevant to your task:

| File | When to read |
|------|--------------|
| `agent_docs/[file].md` | [trigger condition] |

## Working Conventions

- [Universal convention 1]
- [Universal convention 2]
```

### Step 5: Create Supporting Structure (if requested)

If the user wants progressive disclosure:

1. **Create agent_docs/ directory** with:
   - `development-commands.md` - Full command reference
   - `architecture.md` - Detailed system design
   - `testing.md` - Test patterns and strategies
   - `deployment.md` - Deployment procedures

2. **Keep each doc focused** - One topic per file

3. **Add clear "when to read" triggers** in CLAUDE.md reference table

### Step 6: Customize .claude Commands (if requested)

If the user wants to customize the .claude commands for their project:

1. **Read each command file** in `.claude/commands/`

2. **Identify project-specific customizations**:
   - Update verification commands (e.g., `pnpm test` → `npm test` or `make test`)
   - Update directory references to match project structure
   - Add project-specific patterns and conventions
   - Update Linear/ticket workflow states if using Linear

3. **Update each command** with project-specific information:
   - `create_plan.md` - Add project-specific patterns section
   - `create_worktree.md` - Update base branch name, env file paths
   - `research_codebase.md` - Add key directories and important files section
   - `linear.md` - Add team IDs, project IDs, workflow states if applicable

4. **Update agent descriptions** if needed:
   - Add project-specific context to agent prompts
   - Update directory structure examples

Example customization for `create_plan.md`:

```markdown
## Project-Specific Patterns

### For New API Endpoints:
- Add route in `src/routes/`
- Create controller in `src/controllers/`
- Add service in `src/services/`
- Add tests in `tests/`

### For Database Changes:
- Create migration: `npm run migrate:create`
- Run migration: `npm run migrate`
- Update models in `src/models/`
```

### Step 7: Review and Iterate

Present the draft:

```
I've created the CLAUDE.md at the project root.

**Line count**: [X] lines (target: <60 for simple projects, <150 for complex ones)

Please review and let me know:
- Is any section too verbose?
- Are there missing essential instructions?
- Should any content move to agent_docs/?

Remember: Less is more. Every line should be universally applicable.
```

## Quality Checklist

Before finalizing, verify:

- [ ] Under 300 lines (ideally under 100)
- [ ] No code style/lint rules embedded
- [ ] No task-specific "hotfixes"
- [ ] All instructions are universally applicable
- [ ] Commands are verified to work
- [ ] Architecture is accurate
- [ ] Progressive disclosure is used for details
- [ ] No placeholder or generic content

## Anti-Patterns to Avoid

**Do NOT include**:
- Code style guidelines (use linters)
- Detailed API documentation (use agent_docs/)
- Task-specific instructions (they get ignored)
- Verbose explanations (keep it terse)
- Unverified assumptions about the codebase
- Generic boilerplate that doesn't apply

**Do NOT**:
- Copy-paste from templates without customization
- Include more than 3-4 verification commands
- Add instructions "just in case"
- Embed code snippets (they get outdated)

## Example Output

For a simple Node.js project:

```markdown
# CLAUDE.md

## What This Project Is

API service for processing payments. Handles Stripe webhooks, stores transactions, sends notifications.

**Tech**: Express, TypeScript, PostgreSQL, pnpm

## Architecture

```
Client → API (Express) → PostgreSQL
                      → Stripe API
                      → Email Service
```

**Key paths**:
- `src/routes/` - API endpoints
- `src/services/` - Business logic
- `src/db/` - Database models and migrations

## How to Verify Changes

```bash
pnpm build        # Build
pnpm test         # Run tests
pnpm lint         # Lint
```

## Reference Documentation

| File | When to read |
|------|--------------|
| `agent_docs/stripe-integration.md` | Working with payments |
| `agent_docs/database.md` | Schema changes or migrations |

## Working Conventions

- All API responses use the format in `src/utils/response.ts`
- Database migrations must be backwards compatible
```

## Handling Existing CLAUDE.md

If improving an existing file:

1. **Read the current CLAUDE.md** completely
2. **Identify**: Verbose sections, outdated info, missing essentials
3. **Propose changes** before implementing
4. **Preserve** project-specific knowledge that is accurate
5. **Remove** generic or redundant content

## Subdirectory CLAUDE.md Files

For monorepos, each package can have its own CLAUDE.md:

- Keep package-level files even shorter (30-50 lines)
- Reference the root CLAUDE.md for shared conventions
- Focus only on package-specific details
- Avoid duplicating root-level information
