# Debug

You are tasked with helping debug issues during manual testing or implementation. This command allows you to investigate problems by examining logs, system state, and git history without editing files. Think of this as a way to bootstrap a debugging session without using the primary window's context.

## SSR Principles

- **Simple**: Focus on one issue at a time, use standard debugging tools
- **Systematic**: Follow structured investigation steps, document findings
- **Reliable**: Verify system state before suggesting solutions

## Critical Checks

- [ ] Problem description is specific with error messages/symptoms
- [ ] Log files exist and are readable at expected locations
- [ ] Database/services are accessible for investigation (if applicable)
- [ ] Git state is clean and recent changes are understood

## Initial Response

When invoked WITH a plan/ticket file:

```
I'll help debug issues with [file name]. Let me understand the current state.

What specific problem are you encountering?
- What were you trying to test/implement?
- What went wrong?
- Any error messages?

I'll investigate the logs, system state, and git history to help figure out what's happening.
```

When invoked WITHOUT parameters:

```
I'll help debug your current issue.

Please describe what's going wrong:
- What are you working on?
- What specific problem occurred?
- When did it last work?

I can investigate logs, system state, and recent changes to help identify the issue.
```

## Environment Investigation

You have access to these key tools:

**Logs** (locations vary by project):

- Application logs (check `logs/`, `tmp/`, or configured log paths)
- Server logs (stdout/stderr from running processes)
- Framework-specific logs (Rails logs, Node debug output, etc.)

**Database** (if applicable):

- Check database connectivity
- Query recent data for anomalies
- Verify migrations are up to date

**Git State**:

- Check current branch, recent commits, uncommitted changes
- Similar to how `commit` and `describe_pr` commands work

**Process Status**:

- Check if services are running: `ps aux | grep [service]`
- Check ports: `lsof -i :[port]`

## Process Steps

### Step 1: Understand the Problem

After the user describes the issue:

1. **Read any provided context** (plan or ticket file):
   - Understand what they're implementing/testing
   - Note which phase or step they're on
   - Identify expected vs actual behavior

2. **Quick state check**:
   - Current git branch and recent commits
   - Any uncommitted changes
   - When the issue started occurring

### Step 2: Investigate the Issue

Spawn parallel Task agents for efficient investigation:

```
Task 1 - Check Recent Logs:
Find and analyze the most recent logs for errors:
1. Find application logs in common locations
2. Search for errors, warnings, or issues around the problem timeframe
3. Look for stack traces or repeated errors
Return: Key errors/warnings with timestamps
```

```
Task 2 - System State:
Check the current system state:
1. Verify services are running
2. Check database connectivity (if applicable)
3. Verify environment variables are set correctly
4. Look for resource issues (disk space, memory)
Return: Relevant system findings
```

```
Task 3 - Git and File State:
Understand what changed recently:
1. Check git status and current branch
2. Look at recent commits: git log --oneline -10
3. Check uncommitted changes: git diff
4. Verify expected files exist
5. Look for any file permission issues
Return: Git state and any file issues
```

### Step 3: Present Findings

Based on the investigation, present a focused debug report:

````markdown
## Debug Report

### What's Wrong

[Clear statement of the issue based on evidence]

### Evidence Found

**From Logs**:

- [Error/warning with timestamp]
- [Pattern or repeated issue]

**From System State**:

- [Service status]
- [Resource availability]

**From Git/Files**:

- [Recent changes that might be related]
- [File state issues]

### Root Cause

[Most likely explanation based on evidence]

### Next Steps

1. **Try This First**:

   ```bash
   [Specific command or action]
   ```

2. **If That Doesn't Work**:
   - Restart services
   - Check configuration files
   - Run with debug/verbose mode enabled

### Can't Access?

Some issues might be outside my reach:

- Browser console errors (F12 in browser)
- Internal service state
- System-level issues

Would you like me to investigate something specific further?
````

## Safety Validations

- Always verify log file paths exist before attempting to read
- Test database connectivity before running queries
- Confirm git repository state before analyzing commits
- Never suggest destructive operations without explicit user confirmation

## Investigation Boundaries

Some issues are outside investigation scope:

- Browser console errors (user must check F12 manually)
- Internal service state (requires specific tools)
- System-level permissions or network issues
- Memory/performance issues requiring profiling tools

## Important Notes

- **Focus on manual testing scenarios** - This is for debugging during implementation
- **Always require problem description** - Can't debug without knowing what's wrong
- **Read files completely** - No limit/offset when reading context
- **Think like `commit` or `describe_pr`** - Understand git state and changes
- **Guide back to user** - Some issues (browser console, internals) are outside reach
- **No file editing** - Pure investigation only

## Quick Reference

**Git State**:

```bash
git status
git log --oneline -10
git diff
```

**Process Check**:

```bash
ps aux | grep [service]
lsof -i :[port]
```

**Log Search**:

```bash
tail -100 [log_file]
grep -i error [log_file]
```

Remember: This command helps you investigate without burning the primary window's context. Perfect for when you hit an issue during manual testing and need to dig into logs, system state, or git history.
