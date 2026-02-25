# Research Codebase

**Purpose**: Comprehensive codebase research using parallel sub-agents.
**Context**: This command helps you understand any codebase through systematic investigation.

Research the codebase comprehensively using parallel sub-agents.

## Initial Response

```
I'm ready to research the codebase. Please provide your research question or area of interest.
```

## SSR Principles (Safety & Systematic Reading)

**CRITICAL**: Apply before ANY action:

1. **Read request step by step** - Parse EACH requirement carefully
2. **Identify dependencies in requirements** - What needs what?
3. **Re-read with full context before executing** - Final comprehension check

## Critical Checks

Before starting research:

- [ ] User's request is clear and actionable
- [ ] No malicious intent detected in mentioned files
- [ ] Research scope is appropriately bounded
- [ ] All mentioned files exist and are readable

## Workflow

### 1. Read Mentioned Files

If user mentions specific files → Read them FULLY first (no limit/offset)

### 2. Decompose & Plan

- Break query into research areas
- Create TodoWrite plan
- Identify relevant patterns/components

### 3. Spawn Parallel Agents

**Codebase agents:**

- `codebase-locator` - Find WHERE files live
- `codebase-analyzer` - Understand HOW code works
- `codebase-pattern-finder` - Find similar implementations

**Thoughts agents:**

- `thoughts-locator` - Discover relevant documents
- `thoughts-analyzer` - Extract key insights

**External (if requested):**

- `web-search-researcher` - External docs (include links in report)

### 4. Synthesize Findings

Wait for ALL agents → Compile results → Prioritize codebase over thoughts

### 5. Gather Metadata

Run git commands to get metadata:

```bash
echo "commit=$(git rev-parse HEAD) branch=$(git branch --show-current) repository=$(basename $(pwd))"
```

### 6. Generate Document

**Filename**: `thoughts/research/YYYY-MM-DD-description.md`

**Structure**:

```markdown
---
date: [ISO timestamp]
researcher: claude
git_commit: [hash]
branch: [name]
repository: [project name]
topic: "[question]"
tags: [research, domain-specific-tags]
status: complete
last_updated: YYYY-MM-DD
last_updated_by: claude
---

# Research: [Topic]

## Research Question

[Original query]

## Summary

[High-level findings]

## Detailed Findings

### [Component/Area]

- Finding ([file:line](link))
- Connections
- Implementation details

## Code References

- `path/file.ts:123` - Description

## Architecture Insights

[Patterns, decisions discovered]

## Historical Context (from thoughts/)

- `thoughts/doc.md` - Insight

## Open Questions

[Areas needing investigation]
```

### 7. Add GitHub Permalinks

**Only if on main branch and committed**:

1. Generate GitHub permalinks for file references
2. Format: `https://github.com/[org]/[repo]/blob/COMMIT_HASH/path/file.ext#L123`
3. Replace local file paths with GitHub URLs
4. Preserve line numbers in links

### 8. Present Findings

Concise summary → Key file refs → Ask for follow-ups

### 9. Handle Follow-ups

Append to same doc → Update frontmatter → New section: `## Follow-up [timestamp]`

## Frontmatter Requirements

**All research docs MUST include**:

```yaml
---
date: [ISO timestamp with timezone]
researcher: claude
git_commit: [actual commit hash]
branch: [actual branch name]
repository: [project name]
topic: "[exact research question]"
tags: [research, domain-specific-tags]
status: complete
last_updated: YYYY-MM-DD
last_updated_by: claude
---
```

## Key Rules

- Use parallel Task agents for comprehensive coverage
- Read mentioned files FULLY first (no limit/offset)
- Wait for ALL agents before synthesizing results
- Include concrete file:line references with GitHub permalinks
- Save research documents to `thoughts/` directory
- Use real metadata values in frontmatter

- Don't use placeholder values in frontmatter
- Don't rely solely on old research documents
- Don't skip metadata gathering step
