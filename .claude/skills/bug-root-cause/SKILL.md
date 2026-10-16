---
name: bug-root-cause
description: Root Cause Analysis Protocol. Use when a feature is broken, flaky, laggy, or behaves unexpectedly (wrong data, UI flashing, deletes the wrong thing, edits not saving, slow sync). Finds and fixes the ACTUAL failing line instead of adding logging or try/catch, and returns the root cause plus the real fix.
---

# Root Cause Analysis Protocol

When a feature is broken, don't just add logging - find and fix the ACTUAL problem.

## Methodology

### 1. Understand the Symptom
- What does the user see/experience?
- What SHOULD happen?
- What ACTUALLY happens?

### 2. Trace the Data Flow
- Follow code execution from UI → ViewModel → Service → Backend
- Check each layer for failures
- Use breakpoint logic (mental trace)

### 3. Check Dependencies
- Is the service initialized? (DIContainer.shared.service)
- Are databases/indexes ready?
- Are async operations completing?
- Are errors being swallowed?

### 4. Find the Bug
- Don't stop at "add try/catch" or "add logging"
- Find the EXACT line where logic fails
- Understand WHY it fails

### 5. Fix It Properly
- Fix root cause, not symptoms
- Add defensive checks only AFTER fixing core issue
- Test the fix logic

### 6. Verify
- Does the fix address the root cause?
- Are there edge cases?
- Will this prevent recurrence?

## Example: "Search returns no results"

❌ Bad approach:

```swift
// Just add logging
AppLog.info("Search started")
let results = await search(query)
AppLog.info("Search returned \(results.count) results")
```

✅ Good approach:

```swift
// Find WHY search returns nothing:
// 1. Is ScriptureDatabase initialized? → Check init
// 2. Are indexes built? → Check index creation
// 3. Is query being processed? → Check query transformation
// 4. FIX the actual issue (e.g., index not built on first launch)

// THEN add logging to prevent future issues
```

## Output

Return the root cause and the actual fix that solves it.

## Layer map for this repo (northstar-calendar)

The generic "UI → ViewModel → Service → Backend" trace maps to:

1. **UI**: `src/components/*.tsx` (WeekView, EventPanel, MarginNotes, ...)
2. **Actions / state**: `src/components/App.tsx` (`EventActions`, undo, `db-changed` refetch)
3. **Backend bridge**: `src/lib/backend.ts` → Tauri IPC (native) or `src/lib/mockBackend.ts` (browser).
   The mock can hide native-only bugs (snapshot identity, `null` vs "unchanged" fields), so
   confirm a mock-only reproduction against the native path.
4. **Commands**: `src-tauri/src/lib.rs` (Tauri commands, `db-changed` emits, test hook `:14211`)
5. **Store + sync**: `crates/sync-core` (SQLite store, pending-op queue, Google push/pull, echo suppression)

Reproduce with a failing test before fixing: Playwright (`npm run test:e2e`) for UI logic,
`npm run test:rust` for sync-core, and the real webview (`npm run test:e2e:app`) for anything
the mock can't show (timing, flashing, native snapshots).
