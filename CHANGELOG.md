# Changelog

This is a maintained fork of [moxystudio/node-proper-lockfile](https://github.com/moxystudio/node-proper-lockfile). All notable changes to this fork are documented here.

## 5.0.0 — 2026-07-05

### Added

- `onReclaimed` option to be notified when a compromised lock is reclaimed by another process (#105).
- TypeScript type definitions (`index.d.ts`), passing `tsc --strict`.

### Fixed

- Race condition where removing a stale lock could delete another process's fresh lock, resulting in two simultaneous lock holders. Stale locks are now taken over atomically via `rename` plus an `mtime` check (#121).
- `ELOCKED` error now includes a hint about the `retries` option to clarify its usage (#92).

### Changed

- Updated dependencies: `retry` to 0.13 and `graceful-fs` to 4.2.11. `signal-exit` is intentionally kept on v3, since v4 changed its API.
