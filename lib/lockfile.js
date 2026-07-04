'use strict';

const path = require('path');
const fs = require('graceful-fs');
const retry = require('retry');
const onExit = require('signal-exit');
const mtimePrecision = require('./mtime-precision');

const locks = {};

function getLockFile(file, options) {
    return options.lockfilePath || `${file}.lock`;
}

function resolveCanonicalPath(file, options, callback) {
    if (!options.realpath) {
        return callback(null, path.resolve(file));
    }

    // Use realpath to resolve symlinks
    // It also resolves relative paths
    options.fs.realpath(file, callback);
}

function lockHeldError(file) {
    return Object.assign(
        new Error('Lock file is already being held. If you expect concurrent access to the same resource, use the `retries` option to wait for it to be released'),
        { code: 'ELOCKED', file }
    );
}

function acquireLock(file, options, callback) {
    const lockfilePath = getLockFile(file, options);

    // Use mkdir to create the lockfile (atomic operation)
    options.fs.mkdir(lockfilePath, (err) => {
        if (!err) {
            // At this point, we acquired the lock!
            // Probe the mtime precision
            return mtimePrecision.probe(lockfilePath, options.fs, (err, mtime, mtimePrecision) => {
                // If it failed, try to remove the lock..
                /* istanbul ignore if */
                if (err) {
                    options.fs.rmdir(lockfilePath, () => {});

                    return callback(err);
                }

                callback(null, mtime, mtimePrecision);
            });
        }

        // If error is not EEXIST then some other error occurred while locking
        if (err.code !== 'EEXIST') {
            return callback(err);
        }

        // Otherwise, check if lock is stale by analyzing the file mtime
        if (options.stale <= 0) {
            return callback(lockHeldError(file));
        }

        options.fs.stat(lockfilePath, (err, stat) => {
            if (err) {
                // Retry if the lockfile has been removed (meanwhile)
                // Skip stale check to avoid recursiveness
                if (err.code === 'ENOENT') {
                    return acquireLock(file, { ...options, stale: 0 }, callback);
                }

                return callback(err);
            }

            if (!isLockStale(stat, options)) {
                return callback(lockHeldError(file));
            }

            // If it's stale, reclaim it and try again!
            reclaimStaleLock(lockfilePath, stat, options, (err, reclaimed) => {
                if (err) {
                    return callback(err);
                }

                if (!reclaimed) {
                    return callback(lockHeldError(file));
                }

                // Skip stale check to avoid recursiveness
                acquireLock(file, { ...options, stale: 0 }, (err, mtime, mtimePrecision) => {
                    // Signal that this acquisition reclaimed a stale lock, e.g. so that
                    // the caller can run crash-recovery procedures exactly once
                    if (!err && typeof options.onReclaimed === 'function') {
                        options.onReclaimed();
                    }

                    callback(err, mtime, mtimePrecision);
                });
            });
        });
    });
}

function isLockStale(stat, options) {
    return stat.mtime.getTime() < Date.now() - options.stale;
}

function reclaimStaleLock(lockfilePath, staleStat, options, callback) {
    // Claim the stale lock by atomically renaming it to a unique path: only one
    // of the competing processes can win the rename. Removing the dir directly
    // would allow a delayed process to rmdir a lock that another process had
    // just re-created, ending up with two processes holding the same lock
    const claimPath = `${lockfilePath}.reclaim-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

    options.fs.rename(lockfilePath, claimPath, (err) => {
        if (err) {
            // ENOENT means another process claimed or released it meanwhile;
            // the caller may still race for the now-free path
            if (err.code === 'ENOENT') {
                return callback(null, true);
            }

            return callback(err);
        }

        options.fs.stat(claimPath, (err, claimedStat) => {
            const isSameLock = !err && claimedStat.mtime.getTime() === staleStat.mtime.getTime();

            // If the dir we grabbed is not the stale one we saw before (the holder
            // refreshed it or it was re-created meanwhile), give it back and
            // report the lock as held
            if (!isSameLock) {
                return options.fs.rename(claimPath, lockfilePath, () => callback(null, false));
            }

            removeLock(claimPath, { ...options, lockfilePath: claimPath }, (err) => {
                if (err) {
                    return callback(err);
                }

                callback(null, true);
            });
        });
    });
}

function removeLock(file, options, callback) {
    // Remove lockfile, ignoring ENOENT errors
    options.fs.rmdir(getLockFile(file, options), (err) => {
        if (err && err.code !== 'ENOENT') {
            return callback(err);
        }

        callback();
    });
}

function updateLock(file, options) {
    const lock = locks[file];

    // Just for safety, should never happen
    /* istanbul ignore if */
    if (lock.updateTimeout) {
        return;
    }

    lock.updateDelay = lock.updateDelay || options.update;
    lock.updateTimeout = setTimeout(() => {
        lock.updateTimeout = null;

        // Stat the file to check if mtime is still ours
        // If it is, we can still recover from a system sleep or a busy event loop
        options.fs.stat(lock.lockfilePath, (err, stat) => {
            const isOverThreshold = lock.lastUpdate + options.stale < Date.now();

            // If it failed to update the lockfile, keep trying unless
            // the lockfile was deleted or we are over the threshold
            if (err) {
                if (err.code === 'ENOENT' || isOverThreshold) {
                    return setLockAsCompromised(file, lock, Object.assign(err, { code: 'ECOMPROMISED' }));
                }

                lock.updateDelay = 1000;

                return updateLock(file, options);
            }

            const isMtimeOurs = lock.mtime.getTime() === stat.mtime.getTime();

            if (!isMtimeOurs) {
                return setLockAsCompromised(
                    file,
                    lock,
                    Object.assign(
                        new Error('Unable to update lock within the stale threshold'),
                        { code: 'ECOMPROMISED' }
                    ));
            }

            const mtime = mtimePrecision.getMtime(lock.mtimePrecision);

            options.fs.utimes(lock.lockfilePath, mtime, mtime, (err) => {
                const isOverThreshold = lock.lastUpdate + options.stale < Date.now();

                // Ignore if the lock was released
                if (lock.released) {
                    return;
                }

                // If it failed to update the lockfile, keep trying unless
                // the lockfile was deleted or we are over the threshold
                if (err) {
                    if (err.code === 'ENOENT' || isOverThreshold) {
                        return setLockAsCompromised(file, lock, Object.assign(err, { code: 'ECOMPROMISED' }));
                    }

                    lock.updateDelay = 1000;

                    return updateLock(file, options);
                }

                // All ok, keep updating..
                lock.mtime = mtime;
                lock.lastUpdate = Date.now();
                lock.updateDelay = null;
                updateLock(file, options);
            });
        });
    }, lock.updateDelay);

    // Unref the timer so that the nodejs process can exit freely
    // This is safe because all acquired locks will be automatically released
    // on process exit

    // We first check that `lock.updateTimeout.unref` exists because some users
    // may be using this module outside of NodeJS (e.g., in an electron app),
    // and in those cases `setTimeout` return an integer.
    /* istanbul ignore else */
    if (lock.updateTimeout.unref) {
        lock.updateTimeout.unref();
    }
}

function setLockAsCompromised(file, lock, err) {
    // Signal the lock has been released
    lock.released = true;

    // Cancel lock mtime update
    // Just for safety, at this point updateTimeout should be null
    /* istanbul ignore if */
    if (lock.updateTimeout) {
        clearTimeout(lock.updateTimeout);
    }

    if (locks[file] === lock) {
        delete locks[file];
    }

    lock.options.onCompromised(err);
}

// ----------------------------------------------------------

function lock(file, options, callback) {
    /* istanbul ignore next */
    options = {
        stale: 10000,
        update: null,
        realpath: true,
        retries: 0,
        fs,
        onCompromised: (err) => { throw err; },
        onReclaimed: null,
        ...options,
    };

    options.retries = options.retries || 0;
    options.retries = typeof options.retries === 'number' ? { retries: options.retries } : options.retries;
    options.stale = Math.max(options.stale || 0, 2000);
    options.update = options.update == null ? options.stale / 2 : options.update || 0;
    options.update = Math.max(Math.min(options.update, options.stale / 2), 1000);

    // Resolve to a canonical file path
    resolveCanonicalPath(file, options, (err, file) => {
        if (err) {
            return callback(err);
        }

        // Attempt to acquire the lock
        const operation = retry.operation(options.retries);

        operation.attempt(() => {
            acquireLock(file, options, (err, mtime, mtimePrecision) => {
                if (operation.retry(err)) {
                    return;
                }

                if (err) {
                    return callback(operation.mainError());
                }

                // We now own the lock
                const lock = locks[file] = {
                    lockfilePath: getLockFile(file, options),
                    mtime,
                    mtimePrecision,
                    options,
                    lastUpdate: Date.now(),
                };

                // We must keep the lock fresh to avoid staleness
                updateLock(file, options);

                callback(null, (releasedCallback) => {
                    if (lock.released) {
                        return releasedCallback &&
                            releasedCallback(Object.assign(new Error('Lock is already released'), { code: 'ERELEASED' }));
                    }

                    // Not necessary to use realpath twice when unlocking
                    unlock(file, { ...options, realpath: false }, releasedCallback);
                });
            });
        });
    });
}

function unlock(file, options, callback) {
    options = {
        fs,
        realpath: true,
        ...options,
    };

    // Resolve to a canonical file path
    resolveCanonicalPath(file, options, (err, file) => {
        if (err) {
            return callback(err);
        }

        // Skip if the lock is not acquired
        const lock = locks[file];

        if (!lock) {
            return callback(Object.assign(new Error('Lock is not acquired/owned by you'), { code: 'ENOTACQUIRED' }));
        }

        lock.updateTimeout && clearTimeout(lock.updateTimeout); // Cancel lock mtime update
        lock.released = true; // Signal the lock has been released
        delete locks[file]; // Delete from locks

        removeLock(file, options, callback);
    });
}

function check(file, options, callback) {
    options = {
        stale: 10000,
        realpath: true,
        fs,
        ...options,
    };

    options.stale = Math.max(options.stale || 0, 2000);

    // Resolve to a canonical file path
    resolveCanonicalPath(file, options, (err, file) => {
        if (err) {
            return callback(err);
        }

        // Check if lockfile exists
        options.fs.stat(getLockFile(file, options), (err, stat) => {
            if (err) {
                // If does not exist, file is not locked. Otherwise, callback with error
                return err.code === 'ENOENT' ? callback(null, false) : callback(err);
            }

            // Otherwise, check if lock is stale by analyzing the file mtime
            return callback(null, !isLockStale(stat, options));
        });
    });
}

function getLocks() {
    return locks;
}

// Remove acquired locks on exit
/* istanbul ignore next */
onExit(() => {
    for (const file in locks) {
        const options = locks[file].options;

        try { options.fs.rmdirSync(getLockFile(file, options)); } catch (e) { /* Empty */ }
    }
});

module.exports.lock = lock;
module.exports.unlock = unlock;
module.exports.check = check;
module.exports.getLocks = getLocks;
