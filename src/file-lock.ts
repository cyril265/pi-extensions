import lockfile from "proper-lockfile";

export async function withFileLock<T>(
  path: string,
  wait: boolean,
  operation: (checkLock: () => void) => Promise<T>,
): Promise<T> {
  let compromised: Error | undefined;
  const checkLock = () => {
    if (compromised) throw compromised;
  };
  const release = await lockfile.lock(path, {
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
  try {
    checkLock();
    const result = await operation(checkLock);
    checkLock();
    return result;
  } finally {
    try {
      await release();
    } catch (error) {
      if (!compromised) throw error;
    }
    checkLock();
  }
}
