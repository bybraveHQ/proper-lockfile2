# @bybrave/proper-lockfile2

[![CI](https://github.com/bybraveHQ/proper-lockfile2/actions/workflows/ci.yml/badge.svg)](https://github.com/bybraveHQ/proper-lockfile2/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@bybrave/proper-lockfile2.svg)](https://www.npmjs.com/package/@bybrave/proper-lockfile2)
[![node](https://img.shields.io/node/v/@bybrave/proper-lockfile2.svg?color=339933&logo=node.js&logoColor=white)](https://www.npmjs.com/package/@bybrave/proper-lockfile2)
[![types](https://img.shields.io/badge/types-included-3178C6?logo=typescript&logoColor=white)](index.d.ts)
[![license](https://img.shields.io/npm/l/@bybrave/proper-lockfile2.svg?color=blue)](LICENSE)

Maintained fork of [proper-lockfile](https://github.com/moxystudio/node-proper-lockfile) — an inter-process and inter-machine lockfile utility that works on a local or network file system.

## Why this fork

The original `proper-lockfile` has not been released since 2021. This fork is a drop-in replacement that fixes a real double-lock race and ships the most requested features:

| Change | Upstream issue |
|---|---|
| **Stale-lock reclaim race fixed**: two processes could both "reclaim" the same stale lock and end up holding it simultaneously | [#121](https://github.com/moxystudio/node-proper-lockfile/issues/121), root cause of many [#92](https://github.com/moxystudio/node-proper-lockfile/issues/92) reports |
| `onReclaimed` callback: know when your lock was acquired by reclaiming a stale one (e.g. to run crash recovery exactly once) | [#105](https://github.com/moxystudio/node-proper-lockfile/issues/105) |
| `ELOCKED` error message now hints at the `retries` option — the most common source of confusion | [#92](https://github.com/moxystudio/node-proper-lockfile/issues/92) |
| TypeScript type definitions included | — |
| Updated dependencies, CI on Node 18/20/22, original test suite preserved (76 tests) + race regression tests | — |

### The race, in short

Upstream reclaims a stale lock with `rmdir` + `mkdir`. If process A detects a stale lock but stalls before its `rmdir`, process B can reclaim the lock and create a fresh one — which A's late `rmdir` then silently deletes, and both processes believe they own the lock. This fork claims stale locks by atomically **renaming** them to a unique path (only one process can win a rename) and verifies the claimed directory is still the stale one it saw. A reproduction script and regression tests are in [`test/fork.test.js`](test/fork.test.js).

## Install

```sh
npm install @bybrave/proper-lockfile2
```

## Usage

```js
const lockfile = require('@bybrave/proper-lockfile2');

const release = await lockfile.lock('some/file');
// do your critical work...
await release();
```

Wait for a held lock instead of failing:

```js
const release = await lockfile.lock('some/file', {
  retries: { retries: 5, maxTimeout: 1000 },
});
```

Run crash recovery when a stale lock (left by a dead process) is reclaimed:

```js
const release = await lockfile.lock('some/file', {
  onReclaimed: () => runRecovery(),
});
```

Sync API: `lockSync`, `unlockSync`, `checkSync` (retries are not supported in sync mode).

## API

### lock(file, [options]) → Promise&lt;release&gt;

Acquires a lock on `file`, resolving with a `release()` function. Rejects with `ELOCKED` if the lock is held (and not stale).

| Option | Default | Description |
|---|---|---|
| `stale` | `10000` | Ms after which a non-updated lock is considered stale (min `2000`) |
| `update` | `stale/2` | Interval of lockfile mtime refresh (min `1000`, max `stale/2`) |
| `retries` | `0` | Number of retries (or a [node-retry](https://github.com/tim-kos/node-retry) options object) while acquiring a held lock |
| `realpath` | `true` | Resolve symlinks; set `false` to lock the symlink itself (also allows locking non-existing paths) |
| `onCompromised` | `(err) => { throw err; }` | Called when the lock can no longer be guaranteed |
| `onReclaimed` | — | Called when the lock was acquired by reclaiming a stale lockfile |
| `lockfilePath` | `${file}.lock` | Custom lockfile location |
| `fs` | `graceful-fs` | Custom fs implementation |

### unlock(file, [options]) / check(file, [options]) → Promise

Same semantics as the original: `unlock` releases a lock acquired in this process, `check` resolves with whether the file is currently locked. Options: `stale` (check only), `realpath`, `lockfilePath`, `fs`.

Full conceptual documentation (how mtime-based locking works, its guarantees and caveats) is in the [original README](https://github.com/moxystudio/node-proper-lockfile#readme) — the design is unchanged.

## Migrating from proper-lockfile

It is a drop-in replacement:

```diff
- const lockfile = require('proper-lockfile');
+ const lockfile = require('@bybrave/proper-lockfile2');
```

No API was removed or changed; `onReclaimed` is the only new option.

## Support

If this package saves you time, you can support maintenance:

[![Ko-fi](https://img.shields.io/badge/Ko--fi-buy%20me%20a%20coffee-FF5E5B?logo=kofi&logoColor=white)](https://ko-fi.com/bybrave)
[![Bitcoin](https://img.shields.io/badge/Bitcoin-BTC-F7931A?logo=bitcoin&logoColor=white)](#support)

Bitcoin (BTC): `bc1q37557q5jpeaxqydzwvf3jgj7zhnfpn2td3q40q`

## Credits & license

MIT. Based on [proper-lockfile](https://github.com/moxystudio/node-proper-lockfile) by André Cruz / MOXY.
