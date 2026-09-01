---
name: design-delegation
description: Delegate new or materially changed mobile UI/UX design work to Claude Design before implementation. Use when a feature requires a new page, major UI section, user flow, navigation UX, modal, bottom sheet, dialog, empty/error state, or other product design decision not already defined by the existing design.
user-invocable: false
---

# Design Delegation

## Overview

Claude Code owns implementation. Claude Design owns product design.

When a feature needs UI/UX that the existing design does not already answer, request the design from Claude Design **first**, then implement against that result. Never implement an improvised screen and retrofit the design afterwards.

```
requirements → identify design gap → Claude Design → design result → Claude Code implements
```

## Design Source of Truth

Claude Design project (existing Rehearsal App design):

```
https://claude.ai/design/p/08fad416-4a6b-4b4c-a905-0c0319ab3e2b?file=Rehearsal+App.dc.html
```

- Primary file: `Rehearsal App.dc.html`
- Secondary file (read when needed): `support.js`
- MCP endpoint: `https://api.anthropic.com/v1/design/mcp` (use the existing Claude Design MCP connection for auth)

## The Test

> **Can I tell exactly what to build just by looking at the existing design?**

- **YES** → implement directly. Do not call Claude Design.
- **NO** → delegate to Claude Design.

### Delegate when

| Situation | Example |
|---|---|
| New screen | new page, detail view, settings screen, onboarding step |
| New major UI region | a feature added to an existing screen that changes layout or information hierarchy |
| New user flow | list → detail → action → completion, where the flow does not exist yet |
| UX pattern choice | page vs modal, modal vs bottom sheet, dialog vs inline action, navigation wiring |
| New state UI | empty, error, invalid, success, loading, disabled, permission |
| Existing design has no answer | current components/patterns do not make the composition obvious |

### Do NOT delegate when

- Implementing an already-designed screen as-is
- Reusing an existing component in an obvious place
- Wiring API/data into an already-designed screen
- Copy changes, small spacing tweaks, obvious UI bug fixes
- Toast/state handling that follows an existing pattern verbatim

Adding one button whose placement and style are obvious from the existing screen is implementation, not design. Building the main screen of a new feature is design.

## Workflow

### Step 1 — Extract the design need

Do not forward the whole PRD. Send Claude Design only what it needs:

- Feature purpose
- What the user is trying to do
- Core user flow
- States that must exist
- Product policy already decided
- Existing screens this connects to

### Step 2 — Read the existing design first

Through Claude Design MCP, open `Rehearsal App.dc.html` (and `support.js` if needed) and establish the current typography, color, spacing, components, navigation, layout, and interaction patterns before anything new is proposed.

### Step 3 — Send this brief, then the requirements

Always include this preamble verbatim:

```
This is an existing Rehearsal App design.

Do not redesign the existing application.

Analyze the existing design system, components, navigation patterns,
typography, spacing, colors, and interaction patterns first.

Add only the UI/UX required for the requested feature.

Reuse existing patterns and components whenever possible.

The new feature should feel like it was always part of the existing app.

Analyze the full user flow and add any necessary page, modal,
bottom sheet, dialog, toast, empty state, loading state, error state,
or success state needed to make the flow complete.

Do not change product policy or business rules unless explicitly requested.
If a product-level decision is required, flag it instead of silently
changing the behavior.
```

Then append the feature requirements from Step 1.

### Step 4 — Review the result, then implement

Before coding, confirm what came back:

- New screens added
- Changes to existing screens
- Navigation
- Interaction
- State UI
- CTA placement
- Dialog / bottom sheet usage
- Empty / loading / error states

Then implement it. Claude Design's output is the specification, not a loose reference — do not substitute a different UI. If a technical constraint blocks an exact match, implement the closest viable form and report the difference when it is meaningful.

## Authority Boundaries

**Claude Design decides freely — no per-screen approval needed:**
screens to add, page/modal/bottom-sheet/dialog choice, CTA placement, information priority, layout, empty/loading/error/success states, navigation presentation, how existing components are reused.

**Nobody changes silently — flag as a product decision instead:**
user permissions, new permission types, approval steps, new business rules, feature scope expansion, data policy, any flow that contradicts the stated requirements.

Claude Code must not resolve these unilaterally either. Surface them to the user.

## Preserve the Existing App

This is an addition to Rehearsal App, not a new app.

- Do not modify existing screens unnecessarily
- Do not restructure existing navigation unnecessarily
- Do not invent a new design system
- Reuse existing components first
- If an entry point requires touching an existing screen, keep the change minimal
- New screens must look like the same product

## When the MCP Is Unavailable

If new UI/UX design is needed but Claude Design MCP cannot be reached, **do not finalize an improvised design**.

1. Check the MCP connection state
2. Determine whether it is a connection or an auth problem
3. Continue any non-UI development work that is unblocked
4. Mark the design-dependent work as an explicit blocker

Simple UI whose outcome is unambiguous from existing patterns may still proceed.

## Red Flags — stop and delegate

- "I'll just sketch a screen now and adjust the design later"
- "This layout is probably fine"
- "I'll pick modal vs bottom sheet myself"
- "I'll invent an empty state for this"
- "The design system doesn't cover this, so I'll extend it"

All of these mean: request the design from Claude Design first.
