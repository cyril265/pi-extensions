import lockfile from "proper-lockfile";

export interface FileLockLease {
  check(): void;
  release(): Promise<void>;
}

export function isFileLockUnavailable(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ELOCKED";
}

export function fileLockIsHeld(path: string): Promise<boolean> {
  return lockfile.check(path, {
    realpath: false,
    stale: 30_000,
  });
}

export async function acquireFileLock(path: string, wait: boolean): Promise<FileLockLease> {
  let compromised: Error | undefined;
  const check = () => {
    if (compromised) throw compromised;
  };
  const releaseLock = await lockfile.lock(path, {
    realpath: false,
    stale: 30_000,
    retries: wait ? {
      retries: 10,
      factor: 2,
      minTimeout: 100,
      maxTimeout: 10_000,
      randomize: true,
    } : 0,
    onCompromised: (error) => {
      compromised = error;
    },
  });

  return {
    check,
    release: async () => {
      try {
        await releaseLock();
      } catch (error) {
        if (!compromised) throw error;
      }
      check();
    },
  };
}

export async function withFileLock<T>(
  path: string,
  wait: boolean,
  operation: (checkLock: () => void) => Promise<T>,
): Promise<T> {
  const lease = await acquireFileLock(path, wait);
  try {
    lease.check();
    const result = await operation(lease.check);
    lease.check();
    return result;
  } finally {
    await lease.release();
  }
}
