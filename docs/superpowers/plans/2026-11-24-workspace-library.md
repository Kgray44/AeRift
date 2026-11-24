# Workspace Library Implementation Plan

> **For agentic workers:** use test-driven development and verify each shared-platform journey before including a change.

**Goal:** Make Workspace a visible glass library whose categories open focused, independently actionable workspaces on desktop, iOS, and Android.

**Architecture:** Reuse existing local stores, system pickers, browser operations and shared optical/motion layers. Documents is a read-only classification of generic files (no copies or new permissions). Keep underlying module IDs and settings compatible. Use a single library layout, with real capabilities stated per platform rather than ambiguous universal actions. Preserve transfer and trust behavior.

**Checks:** library/card accessibility and keyboard focus on Back; empty and hidden-module states; selectors and document classification; root-to-detail navigation with system/app reduced motion; cross-category selections and existing save/import workflows; Chromium fixture where available and hosted platform builds. Open mobile imported photos/files through their existing native previewers. Windows workspace copies are saved via the existing download handle; no filesystem location or shell launch is fabricated.
