---
description: Manage .sdd/steering/ as persistent project knowledge
allowed-tools: Read, Task, Glob
---

# SDD Steering Management

## Mode Detection

**Perform detection before invoking Subagent**:

Check `.sdd/steering/` status:
- **Bootstrap Mode**: Empty OR missing core files (product.md, tech.md, structure.md)
- **Sync Mode**: All core files exist

Use Glob to check for existing steering files.

## Invoke Subagent

Delegate steering management to steering-agent:

Use the Task tool to invoke the Subagent with file path patterns:

```
Task(
  subagent_type="steering-agent",
  description="Manage steering files",
  prompt="""
Mode: {bootstrap or sync based on detection}

File patterns to read:
- .sdd/steering/*.md (if sync mode)
- .sdd/settings/templates/steering/*.md
- .sdd/settings/rules/steering-principles.md

JIT Strategy: Fetch codebase files when needed, not upfront
"""
)
```

## Display Result

Show Subagent summary to user:

### Bootstrap:
- Generated steering files: product.md, tech.md, structure.md
- Review and approve as Source of Truth

### Sync:
- Updated steering files
- Code drift warnings
- Recommendations for custom steering

## Notes

- All `.sdd/steering/*.md` loaded as project memory
- Templates and principles are external for customization
- Focus on patterns, not catalogs
- "Golden Rule": New code following patterns shouldn't require steering updates
- Avoid documenting agent-specific tooling directories (e.g. `.cursor/`, `.gemini/`, `.claude/`)
- `.sdd/settings/` content should NOT be documented in steering files (settings are metadata, not project knowledge)
- Light references to `.sdd/specs/` and `.sdd/steering/` are acceptable; avoid other `.sdd/` directories
