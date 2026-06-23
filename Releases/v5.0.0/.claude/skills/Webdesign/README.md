# Webdesign

PAI orchestration skill for **Claude Design** (claude.ai/design) — Anthropic's visual design product launched April 17, 2026.

## What It Does

Drives Claude Design programmatically through the Interceptor skill (real Chrome + authenticated claude.ai session), processes the handoff bundles it produces, and integrates the resulting designs into existing web applications.

Claude Design is the engine. This skill is the cockpit around it.

## Codex / Windows Path

On Windows Codex, do not treat Interceptor as the default browser bridge. Use Codex-native plugins for ordinary web UI work:

- `chrome@openai-bundled` or `browser@openai-bundled` for browser inspection, screenshots, and verification.
- `build-web-apps@openai-curated` with the `frontend-design` and `HumanInterface` skills for implementation.

Reserve Interceptor for workflows that explicitly automate `claude.ai/design`.

## Why This Exists

Claude Design has no API, no CLI, no plugin. It is a surface on claude.ai. To use it inside a CLI-first workflow — as part of site building, blogging, admin panels, or marketing pages — you need a bridge. Webdesign is that bridge.

## Key Capability: Integration-Aware

Most design tools assume greenfield. Webdesign assumes the opposite: you already have an app and need to land a new prototype, page, or component into it cleanly. Workflows like `IntegrateIntoApp` produce diffs on top of existing code, respecting existing tokens and component patterns.

## Prerequisites

- For Codex-native web work: Codex `chrome` / `browser` plugin enabled, and `build-web-apps` installed for implementation guidance.
- For Claude Design automation: [Interceptor skill](https://github.com/anthropics/claude-code) installed as a CLI and authenticated to claude.ai
- Active Claude subscription with Claude Design access (Pro / Max / Team / Enterprise)
- For integration: the target project's framework, token file, and component directory

## Quick Start

```
Skill("Webdesign")

# Then ask:
"Create a prototype for a pricing page for an AI security startup"
"Extract the design system from this codebase at ~/projects/my-site"
"Integrate this prototype into the Astro app at ~/projects/landing"
```

The skill routes your request to the right workflow automatically.

## Workflows

| Workflow | Purpose |
|----------|---------|
| CreatePrototype | Brief → polished prototype via Claude Design |
| ExtractDesignSystem | Codebase / brand files → design tokens |
| RefinePrototype | Iterate on existing Claude Design artifact |
| WebsiteToRedesign | Live URL → modernized rebuild |
| ExportToCode | Handoff bundle → local code |
| IntegrateIntoApp | Prototype → diff against existing application |
| DeployDesign | Built design → production host |

## Relationship to Other Tools

- **`frontend-design` plugin** (Anthropic, auto-activates in Claude Code): the downstream code-generation engine when exporting bundles. Not invoked directly by this skill.
- **Interceptor skill**: required only for Claude Design automation; not required for normal Codex browser/plugin work.
- **Art skill**: for illustrations, diagrams, header images — not overlapping scope.
- **Browser / Chrome plugins**: preferred on Codex for normal browser inspection and verification. Interceptor remains the supported path for authenticated claude.ai Design work.

## License

See LICENSE.txt.
