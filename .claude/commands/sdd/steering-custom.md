---
description: Create custom steering documents for specialized project contexts
allowed-tools: Task
---

# SDD Custom Steering Creation

## Interactive Workflow

This command starts an interactive process with the Subagent:
1. Subagent asks user which template to create, presenting ALL available templates in a single question
2. Subagent checks for available templates
3. Subagent analyzes codebase for relevant patterns
4. Subagent generates custom steering file

## Invoke Subagent

Delegate custom steering creation to steering-custom-agent:

Use the Task tool to invoke the Subagent with file path patterns:

```
Task(
  subagent_type="steering-custom-agent",
  description="Create custom steering",
  prompt="""
Interactive Mode: Ask user for domain/topic

File patterns to read:
- .sdd/settings/templates/steering-custom/*.md
- .sdd/settings/rules/steering-principles.md

JIT Strategy: Analyze codebase for relevant patterns as needed
"""
)
```

## Display Result

Show Subagent summary to user:
- Custom steering file created
- Template used (if any)
- Codebase patterns analyzed
- Content overview

## Available Templates

Available templates in `.sdd/settings/templates/steering-custom/`:

**Project patterns** (customized from codebase analysis):
- api-standards.md, testing.md, security.md, database.md
- error-handling.md, authentication.md, deployment.md
- cross-repo.md *(multi-repo — discovers and writes to all platform repos)*. *Produces persistent AI context — does not create specs.*

**Integrations** (written verbatim after displaying embedded setup guide):
- jira.md — Jira Cloud sync: auto-creates Epics, Stories, and Subtasks at each SDD phase
- azure-devops.md — Azure DevOps Boards sync: auto-creates Epics, User Stories, and Tasks at each SDD phase

For integration templates: display the setup guide in the HTML comment block in chat,
then write the file content verbatim — no codebase analysis needed.

## Notes

- Subagent will interact with user to understand needs
- Templates are starting points, customized for project
- Integration templates are written verbatim (external tools, nothing to analyze in repo)
- All steering files loaded as project memory
- Avoid documenting agent-specific tooling directories (e.g. `.cursor/`, `.gemini/`, `.claude/`)
- `.sdd/settings/` content should NOT be documented (it's metadata, not project knowledge)
- Light references to `.sdd/specs/` and `.sdd/steering/` are acceptable; avoid other `.sdd/` directories
