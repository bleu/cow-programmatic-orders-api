# Linear - Ticket Management

You are tasked with managing Linear tickets, including creating tickets from thoughts documents, updating existing tickets, and following the team's workflow patterns.

## SSR Principles

- **Simple**: Use established templates and avoid complex ticket structures
- **Systematic**: Follow the workflow states in order, validate each transition
- **Reliable**: Always verify team/project exists before creating tickets

## Critical Checks

- [ ] Linear MCP tools are available and functional
- [ ] Thoughts document exists and is readable before creating tickets
- [ ] Team and project IDs are valid before ticket creation
- [ ] Problem statement is clear and user-focused (not just implementation details)
- [ ] Workflow state transitions follow the defined progression

## Initial Setup

First, verify that Linear MCP tools are available by checking if any `mcp__linear__` tools exist. If not, respond:

```
I need access to Linear tools to help with ticket management. Please configure the Linear MCP server first.
```

If tools are available, respond based on the user's request:

## Quick Commands (Shortcuts)

The following keywords trigger specific actions:

| Keyword | Action | Example |
|---------|--------|---------|
| **pull** or **pull-copy** | Fetch from Linear → Create local file(s) | "pull COW-708" or "pull all tasks" |
| **push** | Create/update on Linear from local | "push DRAFT-add-handler" or "push COW-708" |

### Detecting Quick Commands

When parsing user input, check for these patterns:
- `pull <identifier>` or `pull-copy <identifier>` → Go to **Pull Action**
- `pull all` or `pull-copy all` → Go to **Pull All Action**
- `push <identifier>` → Go to **Push Action**

If none of these patterns match, fall back to the general menu.

### For general requests:

```
I can help you with Linear tickets. What would you like to do?
1. Create a new ticket from a thoughts document
2. Create a local draft (sync to Linear later)
3. Sync pending drafts to Linear
4. Add a comment to a ticket (I'll use our conversation context)
5. Search for tickets
6. Update ticket status or details
7. Pull task(s) from Linear to local (use "pull <COW-xxx>" or "pull all")
8. Push local task to Linear (use "push <filename>")
```

### For specific create requests:

```
I'll help you create a Linear ticket from your thoughts document. Please provide:
1. The path to the thoughts document (or topic to search for)
2. Any specific focus or angle for the ticket (optional)
```

Then wait for the user's input.

## Team Workflow & Status Progression

A typical workflow progression (customize to your team's needs):

1. **Triage** → All new tickets start here for initial review
2. **Backlog** → Reviewed and ready to be picked up
3. **Todo** → Planned for upcoming work
4. **In Progress** → Active development
5. **In Review** → PR submitted, awaiting review
6. **Done** → Completed

**Key principle**: Review and alignment happen at the plan stage (not PR stage) to move faster and avoid rework.

## Important Conventions

### Default Values

- **Status**: Always create new tickets in "Triage" or your team's equivalent initial status
- **Priority**: Default to Medium (3) for most tasks, use best judgment or ask user
  - Urgent (1): Critical blockers, security issues
  - High (2): Important features with deadlines, major bugs
  - Medium (3): Standard implementation tasks (default)
  - Low (4): Nice-to-haves, minor improvements
- **Links**: Use the `links` parameter to attach URLs (not just markdown links in description)

## Local Task Files & Linear Sync

### Naming Convention

Local task files follow a two-phase naming scheme that reflects their sync status with Linear:

| Phase | Pattern | Example |
|-------|---------|---------|
| **Draft** (local only) | `DRAFT-<slug>.md` | `DRAFT-add-stop-loss-handler.md` |
| **Synced** (has Linear ID) | `COW-<number>-<slug>.md` | `COW-123-add-stop-loss-handler.md` |

### Why This Matters

The real ticket identifier (e.g., `COW-123`) only exists after the issue is created in Linear. Until then, the file uses a `DRAFT-` prefix with a human-readable slug. This makes it trivial to know which tasks are synced and which are still local drafts.

### Workflow

1. **Creating a local draft**: When the user wants to prepare a task before sending to Linear, create the file as `thoughts/tasks/DRAFT-<slug>.md`. The slug should be a kebab-case summary of the task (e.g., `implement-webhook-retry`, `fix-order-validation`).

2. **Syncing to Linear**: When the draft is sent to Linear via `mcp__linear__create_issue`, the API response returns the issue identifier (e.g., `COW-123`).

3. **Renaming after sync**: Immediately rename the local file from `DRAFT-<slug>.md` to `COW-<number>-<slug>.md`. This makes the sync visible in the filesystem.

4. **Updating internal references**: After renaming, update any cross-references in other thoughts documents that pointed to the old `DRAFT-` filename.

### Listing Sync Status

```bash
# All unsynced drafts
ls thoughts/tasks/DRAFT-*

# All synced tasks
ls thoughts/tasks/COW-*

# Quick count
echo "Drafts: $(ls thoughts/tasks/DRAFT-* 2>/dev/null | wc -l)"
echo "Synced: $(ls thoughts/tasks/COW-* 2>/dev/null | wc -l)"
```

### Important Rules

- **Never guess the Linear ID** - only use the identifier returned by the Linear API after creation.
- **Always rename after sync** - a `DRAFT-` file that has a corresponding Linear ticket is a bug in the workflow.
- **Keep the slug consistent** - when renaming from `DRAFT-<slug>` to `COW-123-<slug>`, preserve the original slug so links and mental models don't break.
- **Add Linear URL to the file** - after syncing, add the Linear ticket URL to the file's frontmatter or header as a back-reference.

## Action-Specific Instructions

### Pull Action (Linear → Local)

**Trigger**: User says "pull <identifier>" or "pull-copy <identifier>"

This action fetches a task from Linear and creates a local file in `thoughts/tasks/`.

#### Prerequisites:
- Ensure `thoughts/tasks/` directory exists (create if needed: `mkdir -p thoughts/tasks`)

#### Steps:

1. **Parse the identifier**:
   - If it's a Linear ID (e.g., `COW-708`, `COW-709`), fetch directly
   - If it's a search term, search Linear and ask user to select

2. **Check if local file already exists**:
   ```bash
   ls thoughts/tasks/COW-<number>-*.md
   ```
   - If file exists, ask user:
     ```
     Local file already exists: `thoughts/tasks/COW-708-project-onboarding.md`
     What would you like to do?
     1. Overwrite with latest from Linear
     2. Keep local version (skip)
     3. Show diff between local and Linear
     ```

3. **Fetch the issue from Linear**:
   ```
   mcp__linear__get_issue with:
   - id: [issue ID or identifier]
   ```

4. **Generate the slug** from title:
   - Convert to kebab-case
   - Remove special characters
   - Example: "Project onboarding/kick off" → `project-onboarding-kick-off`

5. **Create the local file** at `thoughts/tasks/COW-<number>-<slug>.md`:

   ```markdown
   ---
   linear_id: COW-<number>
   linear_url: <ticket URL>
   status: <current status>
   priority: <priority>
   assignee: <assignee>
   created: <created date>
   updated: <updated date>
   linear_synced: true
   ---

   # <Title>

   ## Problem
   <Description from Linear>

   ## Details
   - Priority: <priority>
   - Status: <status>
   - Milestone: <milestone if any>
   - Estimate: <estimate if any>

   ## Implementation Notes
   [To be filled locally]

   ## References
   - Linear: <ticket URL>
   ```

6. **Confirm** to user: "Created local file: `thoughts/tasks/COW-<number>-<slug>.md`"

### Pull All Action (Linear → Local, Multiple)

**Trigger**: User says "pull all" or "pull-copy all"

1. **Fetch all issues** from the configured project:
   ```
   mcp__linear__list_issues with:
   - project: Programmatic Orders API
   - limit: 50
   ```

2. **Show list and ask for confirmation**:
   ```
   Found X tasks in Linear:
   - COW-708: Project onboarding/kick off (In Progress)
   - COW-709: Create initial ponder project (Todo)

   Which tasks do you want to pull?
   1. All of them
   2. Let me select specific ones
   3. Only tasks assigned to me
   4. Cancel
   ```

3. **For each selected task**, run the Pull Action steps (checking for existing files).

4. **Show summary**:
   ```
   Pulled X tasks:
   - Created: thoughts/tasks/COW-708-project-onboarding.md
   - Created: thoughts/tasks/COW-709-create-initial-ponder-project.md

   Skipped (already existed): 0
   ```

### Push Action (Local → Linear)

**Trigger**: User says "push <identifier>"

This action creates or updates a Linear ticket from a local file.

#### Steps:

1. **Parse the identifier and locate the file**:
   - If `DRAFT-<slug>` → Look for `thoughts/tasks/DRAFT-<slug>.md`
   - If `COW-<number>` → Look for `thoughts/tasks/COW-<number>-*.md`
   - If just a slug/keyword → Search in `thoughts/tasks/` directory

2. **Read the local file** and extract:
   - Title (from `# heading`)
   - Description (from content)
   - Frontmatter metadata (linear_id, status, priority, etc.)

3. **Check if this is an existing Linear ticket**:
   - If file has `linear_id` in frontmatter OR filename starts with `COW-`:
     ```
     This task already exists on Linear as COW-<number>.
     What would you like to do?
     1. Update the Linear ticket with local changes
     2. View current Linear version first
     3. Cancel
     ```
   - If user chooses to update:
     ```
     mcp__linear__save_issue with:
     - id: [existing issue ID]
     - title: [updated title]
     - description: [updated description]
     - (other fields as needed)
     ```

4. **If it's a new draft** (DRAFT-* file):
   - Follow the existing "Syncing Pending Drafts to Linear" workflow
   - Create the issue via `mcp__linear__save_issue`
   - Rename file from `DRAFT-<slug>.md` to `COW-<number>-<slug>.md`
   - Update frontmatter with `linear_id` and `linear_url`

5. **Confirm** to user:
   - For new: "Created Linear ticket: COW-<number> - <title>\nURL: <url>\nRenamed local file to: `thoughts/tasks/COW-<number>-<slug>.md`"
   - For update: "Updated Linear ticket: COW-<number> - <title>\nURL: <url>"

### 1. Creating Tickets from Thoughts

#### Steps to follow after receiving the request:

1. **Locate and read the thoughts document:**
   - If given a path, read the document directly
   - If given a topic/keyword, search thoughts/ directory using Grep to find relevant documents
   - If multiple matches found, show list and ask user to select
   - Create a TodoWrite list to track: Read document → Analyze content → Draft ticket → Get user input → Create ticket

2. **Analyze the document content:**
   - Identify the core problem or feature being discussed
   - Extract key implementation details or technical decisions
   - Note any specific code files or areas mentioned
   - Look for action items or next steps
   - Identify what stage the idea is at (early ideation vs ready to implement)

3. **Check for related context (if mentioned in doc):**
   - If the document references specific code files, read relevant sections
   - If it mentions other thoughts documents, quickly check them
   - Look for any existing Linear tickets mentioned

4. **Get Linear workspace context:**
   - List teams: `mcp__linear__list_teams`
   - If multiple teams, ask user to select one
   - List projects for selected team: `mcp__linear__list_projects`

5. **Draft the ticket summary:**
   Present a draft to the user:

   ```
   ## Draft Linear Ticket

   **Title**: [Clear, action-oriented title]

   **Description**:
   [2-3 sentence summary of the problem/goal]

   ## Key Details
   - [Bullet points of important details from thoughts]
   - [Technical decisions or constraints]
   - [Any specific requirements]

   ## Implementation Notes (if applicable)
   [Any specific technical approach or steps outlined]

   ## References
   - Source: `thoughts/[path/to/document.md]`
   - Related code: [any file:line references]
   - Parent ticket: [if applicable]

   ---
   Based on the document, this seems to be at the stage of: [ideation/planning/ready to implement]
   ```

6. **Interactive refinement:**
   Ask the user:
   - Does this summary capture the ticket accurately?
   - Which project should this go in? [show list]
   - What priority? (Default: Medium/3)
   - Any additional context to add?
   - Should we include more/less implementation detail?
   - Do you want to assign it to yourself?

7. **Create the Linear ticket:**

   ```
   mcp__linear__create_issue with:
   - title: [refined title]
   - description: [final description in markdown]
   - teamId: [selected team]
   - projectId: [selected project]
   - priority: [selected priority number, default 3]
   - stateId: [initial status ID]
   - assigneeId: [if requested]
   - links: [{url: "URL", title: "Document Title"}]
   ```

8. **Post-creation actions:**
   - Show the created ticket URL
   - **If the source was a `DRAFT-` file**: Rename it from `DRAFT-<slug>.md` to `COW-<number>-<slug>.md` using the identifier returned by the Linear API. Add the Linear ticket URL to the top of the file.
   - Ask if user wants to:
     - Add a comment with additional implementation details
     - Create sub-tasks for specific action items
     - Update other documents that referenced the old `DRAFT-` filename

### 2. Creating a Local Draft (Without Syncing)

When the user wants to capture a task idea locally before sending to Linear:

1. **Gather task details** from conversation or user input.
2. **Generate a slug**: kebab-case, concise, descriptive (e.g., `add-stop-loss-handler`).
3. **Create the file** at `thoughts/tasks/DRAFT-<slug>.md` with this template:

   ```markdown
   ---
   status: draft
   linear_synced: false
   created: YYYY-MM-DD
   ---

   # [Task Title]

   ## Problem
   [What problem does this solve?]

   ## Details
   [Key details, technical decisions, constraints]

   ## Implementation Notes
   [Approach, if known]

   ## References
   - Source: [link to thoughts doc or conversation context]
   ```

4. **Confirm** to the user: "Draft created at `thoughts/tasks/DRAFT-<slug>.md`. Run `/linear` again when ready to sync to Linear."

### 3. Syncing Pending Drafts to Linear

When the user wants to sync local drafts:

1. **List all `DRAFT-*` files** in `thoughts/tasks/`.
2. **Show the list** to the user and ask which ones to sync (or all).
3. **For each selected draft**:
   - Read the file content
   - Create the Linear issue via `mcp__linear__create_issue`
   - Capture the returned identifier (e.g., `COW-123`)
   - Rename the file: `DRAFT-<slug>.md` → `COW-123-<slug>.md`
   - Update the file frontmatter: set `linear_synced: true` and add `linear_id: COW-123` and `linear_url: <ticket URL>`
   - Update any cross-references in other documents
4. **Show summary**: list of synced drafts with their new Linear IDs.

### 4. Adding Comments and Links to Existing Tickets

When user wants to add a comment to a ticket:

1. **Determine which ticket:**
   - Use context from the current conversation to identify the relevant ticket
   - If uncertain, use `mcp__linear__get_issue` to show ticket details and confirm with user

2. **Format comments for clarity:**
   - Keep comments concise (~10 lines) unless more detail is needed
   - Focus on the key insight or most useful information
   - Include relevant file references with backticks

3. **Handle links properly:**
   - If adding a link with a comment: Update the issue with the link AND mention it in the comment
   - Always add links to the issue itself using the `links` parameter

### 5. Searching for Tickets

When user wants to find tickets:

1. **Gather search criteria:**
   - Query text
   - Team/Project filters
   - Status filters

2. **Execute search:**

   ```
   mcp__linear__list_issues with:
   - query: [search text]
   - teamId: [if specified]
   - projectId: [if specified]
   - limit: 20
   ```

3. **Present results:**
   - Show ticket ID, title, status, assignee
   - Include direct links to Linear

### 6. Updating Ticket Status

When moving tickets through the workflow:

1. **Get current status:**
   - Fetch ticket details
   - Show current status in workflow

2. **Update with context:**

   ```
   mcp__linear__update_issue with:
   - id: [ticket ID]
   - stateId: [new status ID]
   ```

   Consider adding a comment explaining the status change.

## Validation Requirements

Before creating any ticket, ensure:

1. **Problem Statement Required**: If user only provides implementation details, MUST ask: "To write a good ticket, please explain the problem you're trying to solve from a user perspective"
2. **Team/Project Validation**: Always verify team and project exist before creating tickets
3. **Link Validation**: All document links must be accessible and properly formatted

## Quality Gates

- Every ticket must have a clear problem statement
- Implementation details go in separate sections, not the main description
- All external links use the `links` parameter (not just markdown)
- Code references use `path/to/file.ext:linenum` format

## Important Notes

- Keep tickets concise but complete - aim for scannable content
- All tickets should include a clear "problem to solve" - if the user asks for a ticket and only gives implementation details, you MUST ask "To write a good ticket, please explain the problem you're trying to solve from a user perspective"
- Focus on the "what" and "why", include "how" only if well-defined
- Always preserve links to source material using the `links` parameter
- Don't create tickets from early-stage brainstorming unless requested
- Use proper Linear markdown formatting
- Include code references as: `path/to/file.ext:linenum`
- Ask for clarification rather than guessing project/status

## Comment Quality Guidelines

When creating comments, focus on extracting the **most valuable information** for a human reader:

- **Key insights over summaries**: What's the "aha" moment or critical understanding?
- **Decisions and tradeoffs**: What approach was chosen and what it enables/prevents
- **Blockers resolved**: What was preventing progress and how it was addressed
- **State changes**: What's different now and what it means for next steps

Avoid:

- Mechanical lists of changes without context
- Restating what's obvious from code diffs
- Generic summaries that don't add value

## Configuration Section

**Project**: Programmatic Orders API
**Workspace**: bleu-builders
**Team**: CoW
**Project URL**: https://linear.app/bleu-builders/project/programmatic-orders-api-32f4eccdfef0/overview

```yaml
# Bleu Builders - Programmatic Orders API
team_id: "b4475174-7425-4382-94ae-00e67a976aba"  # CoW team
project_id: "f7ab7dc8-2eca-44b3-b89d-ac05eb539b53"  # Programmatic Orders API
project_slug: "32f4eccdfef0"

# Workflow states (CoW team)
states:
  triage: "323433fd-e2b8-49ca-868f-90471880a989"
  backlog: "7821d360-a3b0-427c-b59d-ef38a90ff00d"
  todo: "cd540394-6cd5-4c74-94c7-9560cf51a3d8"
  in_progress: "2db12e1e-fee7-4c39-8b4b-03b48b50f129"
  in_review: "8f1f5acc-e115-4b6b-b0c4-2dc1453afc7b"
  done: "0bb29032-6d2a-4b80-a6a1-50a5ecbc4dcd"
  canceled: "99b62703-b95a-4e24-bbc7-fb02bf76c654"
  duplicate: "dc543197-9f78-403c-846b-e365e98b9cec"

# Labels (workspace-wide)
labels:
  bug: "eb0627d9-3872-4c2a-a8de-d5cdcd2a1a4f"          # # bug
  feature: "62ac5f0d-dafb-4368-9646-8f2aec026168"      # # feature
  improvement: "59ec9323-8907-4957-87ac-4d26369aa1bb"  # # improvement
  tech_debt: "7075c334-49ab-4bfb-9027-6b54a1e12138"    # # tech debt
  chores: "66eed57f-aae8-4dcf-9053-4aa571e65231"       # # chores
  needs_review: "ecb96760-cd66-4ea2-b0ed-5de907ab1bf4" # needs-review
  blocked: "dd13eb7f-5337-4959-9f98-74b399219a22"      # ! blocked by external dep
```
