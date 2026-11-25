# Workspace tool suites

The Workspace is a launcher for working tools in the shared AeRift desktop and mobile shells. Keep the original Workspace cards, shared motion and existing AeRift Glass materials. The suites may compose those components but must not introduce a separate glass recipe, navigation system, device discovery path or trust model.

## Current implementation wave

| Area | What this wave adds | Boundary |
| --- | --- | --- |
| Notes | Search title and body; filter text or Markdown; editor with formatting tools, safe preview, word count, and explicit save | Uses the existing object schema and local persistence. Mobile keeps existing native attachment preview and handoff. Preview escapes content and does not execute HTML or links. |
| File Browser | Search and sort the entire imported catalog before paging; filter by type; reuse and clear locally stored explicit searches | Browses imported copies; does not expose arbitrary filesystem paths or silently access folders outside AeRift. |
| Documents | A document-only catalog search and ordering alongside existing copy/preview actions | Document editing and provider-backed folders are not part of this wave. |
| Images & Videos | Search and filter imported photos and video alongside the existing native preview and transfer actions | No background photo-library scan, media indexing, or editing. |
| Web Browser | Address/search bar, saved links, and clearable opt-in history of explicit opens. iOS and Android use their existing browser surfaces; desktop uses its default browser for now | Never navigate the app's privileged WebView or inject untrusted remote content into it. External history, search terms, query strings, and fragments are not kept. |
| Clipboard | Existing explicit capture and send actions preserved | Multi-entry sorting, filtering, pin groups and exports are next; never read in the background. |
| Collections | Existing object membership and transfer actions preserved | Next: reorder and edit memberships across platforms, search and preview objects without duplicating payloads. |

## Native follow-on gates

1. **Embedded file folders:** Start with an explicitly selected root and native, platform-owned authorization (Windows chosen-root handle, iOS security-scoped provider grant, Android SAF tree). Return opaque paged entry IDs and sanitized metadata, not filesystem authority. Make grant removal and permission expiry visible, and keep paths from escaping the chosen root via links, junctions, races or traversal. Reads, copy, reveal, and mutations require distinct checks. No background crawling by default.
2. **Desktop Web Browser:** Implement an isolated external-content browser view with zero AeRift application IPC or filesystem capability. Preserve privileged main-window CSP and commands; never add an iframe exception to that window. Require navigation policy, popup/download treatment, and separation of saved links from private web sessions before enabling. Retain the system opener explicitly when a platform cannot safely embed.
3. **Artifact galleries:** Keep selection and metadata queries separate from preview bytes. Stream or load thumbnail previews lazily; maintain the existing provider export/preview and transfer consent checks. Build collection editing and clipboard history over their existing objects rather than introducing unrelated copies.
4. **Acceptance:** Test desktop and each mobile shell using existing fixture tests, then verify installed native provider and browser behaviors on actual supported platforms. A simulated route or import picker is not a native file/provider verification.
