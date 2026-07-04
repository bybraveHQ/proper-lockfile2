declare namespace lockfile {
  interface RetryOptions {
    retries?: number;
    factor?: number;
    minTimeout?: number;
    maxTimeout?: number;
    randomize?: boolean;
    forever?: boolean;
    maxRetryTime?: number;
  }

  interface CommonOptions {
    /**
     * @default true
     * Resolve symlinks using realpath; set to false to lock the symlink itself.
     */
    realpath?: boolean;
    /**
     * Custom lockfile path, e.g. to lock a directory into a file inside it.
     */
    lockfilePath?: string;
    /**
     * Custom fs implementation (defaults to graceful-fs).
     */
    fs?: unknown;
  }

  interface LockOptions extends CommonOptions {
    /**
     * @default 10000
     * Duration in ms after which the lock is considered stale (minimum 2000).
     */
    stale?: number;
    /**
     * @default stale/2
     * Interval in ms between lock mtime updates (minimum 1000, maximum stale/2).
     */
    update?: number;
    /**
     * @default 0
     * Number of retries (or a node-retry options object) while acquiring
     * a held lock. Not supported by the sync API.
     */
    retries?: number | RetryOptions;
    /**
     * Called when the lock can no longer be guaranteed (e.g. the update of
     * the lockfile mtime failed within the stale threshold).
     * @default (err) => { throw err; }
     */
    onCompromised?: (err: Error) => void;
    /**
     * Called when the lock was acquired by reclaiming a stale lockfile left
     * behind by a crashed process — e.g. to run recovery procedures.
     */
    onReclaimed?: () => void;
  }

  interface UnlockOptions extends CommonOptions {}

  interface CheckOptions extends CommonOptions {
    /**
     * @default 10000
     * Duration in ms after which the lock is considered stale (minimum 2000).
     */
    stale?: number;
  }

  /**
   * Acquire the lock and resolve with a release function.
   */
  function lock(file: string, options?: LockOptions): Promise<() => Promise<void>>;
  /**
   * Acquire the lock synchronously and return a release function.
   * The `retries` option is not supported here.
   */
  function lockSync(file: string, options?: LockOptions): () => void;
  function unlock(file: string, options?: UnlockOptions): Promise<void>;
  function unlockSync(file: string, options?: UnlockOptions): void;
  /**
   * Resolve with true if the file is currently locked (and not stale).
   */
  function check(file: string, options?: CheckOptions): Promise<boolean>;
  function checkSync(file: string, options?: CheckOptions): boolean;
}

declare function lockfile(
  file: string,
  options?: lockfile.LockOptions
): Promise<() => Promise<void>>;

export = lockfile;
