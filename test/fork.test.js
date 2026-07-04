'use strict';

const fs = require('graceful-fs');
const mkdirp = require('mkdirp');
const rimraf = require('rimraf');
const pDefer = require('p-defer');
const pDelay = require('delay');
const clearTimeouts = require('@segment/clear-timeouts');
const lockfile = require('../');
const unlockAll = require('./util/unlockAll');

const tmpDir = `${__dirname}/tmp`;

clearTimeouts.install();

beforeAll(() => mkdirp.sync(tmpDir));

afterAll(() => rimraf.sync(tmpDir));

afterEach(async () => {
    jest.restoreAllMocks();
    clearTimeouts();

    await unlockAll();
    rimraf.sync(`${tmpDir}/*`);
});

function createStaleLock(file) {
    fs.mkdirSync(`${file}.lock`);

    const staleMtime = new Date(Date.now() - 60000);

    fs.utimesSync(`${file}.lock`, staleMtime, staleMtime);

    return staleMtime;
}

describe('ELOCKED error message', () => {
    it('should hint about the retries option', async () => {
        fs.writeFileSync(`${tmpDir}/foo`, '');

        await lockfile.lock(`${tmpDir}/foo`);

        expect.assertions(2);

        try {
            await lockfile.lock(`${tmpDir}/foo`);
        } catch (err) {
            expect(err.code).toBe('ELOCKED');
            expect(err.message).toMatch(/`retries` option/);
        }
    });
});

describe('onReclaimed option', () => {
    it('should be called when a stale lock was reclaimed', async () => {
        fs.writeFileSync(`${tmpDir}/foo`, '');
        createStaleLock(`${tmpDir}/foo`);

        const onReclaimed = jest.fn();

        const release = await lockfile.lock(`${tmpDir}/foo`, { stale: 2000, onReclaimed });

        expect(onReclaimed).toHaveBeenCalledTimes(1);

        await release();
    });

    it('should not be called on a normal acquisition', async () => {
        fs.writeFileSync(`${tmpDir}/foo`, '');

        const onReclaimed = jest.fn();

        const release = await lockfile.lock(`${tmpDir}/foo`, { onReclaimed });

        expect(onReclaimed).not.toHaveBeenCalled();

        await release();
    });

    it('should work with the sync api (and reclaim staleness synchronously)', () => {
        fs.writeFileSync(`${tmpDir}/foo`, '');
        createStaleLock(`${tmpDir}/foo`);

        const onReclaimed = jest.fn();

        const release = lockfile.lockSync(`${tmpDir}/foo`, { stale: 2000, onReclaimed });

        expect(onReclaimed).toHaveBeenCalledTimes(1);

        release();
    });
});

describe('stale lock reclaim races', () => {
    it('should allow only one of two concurrent reclaimers to acquire the lock', async () => {
        fs.writeFileSync(`${tmpDir}/foo`, '');
        createStaleLock(`${tmpDir}/foo`);

        const results = await Promise.allSettled([
            lockfile.lock(`${tmpDir}/foo`, { stale: 2000 }),
            lockfile.lock(`${tmpDir}/foo`, { stale: 2000 }),
        ]);

        const fulfilled = results.filter((result) => result.status === 'fulfilled');
        const rejected = results.filter((result) => result.status === 'rejected');

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0].reason.code).toBe('ELOCKED');

        await fulfilled[0].value();
    });

    it('should not steal a lock that was re-created after the stale one was reclaimed (#121)', async () => {
        fs.writeFileSync(`${tmpDir}/foo`, '');
        createStaleLock(`${tmpDir}/foo`);

        // Simulate the #121 interleaving: the slow process (p1) detects the stale
        // lock but is parked right before its reclaim; meanwhile the fast process
        // (p2) reclaims the stale lock and re-creates a fresh one; then p1 resumes
        const renameRequested = pDefer();
        const allowRename = pDefer();
        const parkedFs = {
            ...fs,
            rename: (src, dst, callback) => {
                renameRequested.resolve();
                allowRename.promise.then(() => fs.rename(src, dst, callback));
            },
        };

        const p1 = lockfile
            .lock(`${tmpDir}/foo`, { stale: 2000, fs: parkedFs })
            .then(() => null, (err) => err);

        await renameRequested.promise;

        const onCompromised = jest.fn();
        const release2 = await lockfile.lock(`${tmpDir}/foo`, { stale: 2000, onCompromised });

        allowRename.resolve();

        const p1Error = await p1;

        expect(p1Error).not.toBe(null);
        expect(p1Error.code).toBe('ELOCKED');

        // p2's lock must still be in place and healthy
        expect(() => fs.statSync(`${tmpDir}/foo.lock`)).not.toThrow();

        await pDelay(1200);

        expect(onCompromised).not.toHaveBeenCalled();

        await release2();
    });
});
