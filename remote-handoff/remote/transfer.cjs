const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const [control, objects] = process.argv.slice(1);
const hashPattern = /^[0-9a-f]{64}$/;
const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const input = process.stdin.pipe(zlib.createGunzip())[Symbol.asyncIterator]();
let buffered = Buffer.alloc(0);
let temporaryIndex = 0;

const fill = async () => {
  const next = await input.next();
  if (next.done) return false;
  buffered = buffered.length === 0 ? next.value : Buffer.concat([buffered, next.value]);
  return true;
};

const readFrame = async () => {
  let newline;
  while ((newline = buffered.indexOf(10)) === -1) {
    if (!(await fill())) throw new Error("The handoff transfer ended unexpectedly.");
  }
  const frame = JSON.parse(buffered.subarray(0, newline).toString("utf8"));
  buffered = buffered.subarray(newline + 1);
  if (frame === null || typeof frame !== "object") throw new Error("The handoff transfer sent an invalid frame.");
  return frame;
};

const validSize = (size) => Number.isSafeInteger(size) && size >= 0;

const receive = async (target, size, mode, expectedHash) => {
  if (!validSize(size)) throw new Error("The handoff transfer sent an invalid size.");
  const temporary = `${target}.tmp.${process.pid}.${temporaryIndex++}`;
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  const hash = crypto.createHash("sha256");
  try {
    let remaining = size;
    while (remaining > 0) {
      if (buffered.length === 0 && !(await fill())) throw new Error("The handoff transfer ended unexpectedly.");
      const chunk = buffered.subarray(0, Math.min(remaining, buffered.length));
      buffered = buffered.subarray(chunk.length);
      remaining -= chunk.length;
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) offset += fs.writeSync(descriptor, chunk, offset);
    }
    fs.closeSync(descriptor);
    if (expectedHash !== undefined && hash.digest("hex") !== expectedHash) {
      throw new Error(`Received profile object ${expectedHash} does not match its hash.`);
    }
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, target);
  } catch (error) {
    try {
      fs.closeSync(descriptor);
    } catch {}
    fs.rmSync(temporary, { force: true });
    throw error;
  }
};

(async () => {
  const query = await readFrame();
  if (query.kind !== "query" || !Array.isArray(query.objects)) throw new Error("The handoff transfer sent no object query.");
  const expected = new Set();
  for (const hash of query.objects) {
    if (typeof hash !== "string" || !hashPattern.test(hash)) throw new Error("The handoff transfer sent an invalid object hash.");
    if (!fs.existsSync(path.join(objects, hash))) expected.add(hash);
  }
  process.stdout.write(`PI_REMOTE_HANDOFF_MISSING\t${JSON.stringify([...expected])}\n`);

  while (true) {
    const frame = await readFrame();
    if (frame.kind === "end") break;
    if (frame.kind === "object") {
      if (!expected.has(frame.hash)) throw new Error("The handoff transfer sent an unexpected profile object.");
      await receive(path.join(objects, frame.hash), frame.size, 0o600, frame.hash);
      expected.delete(frame.hash);
    } else if (frame.kind === "file") {
      if (typeof frame.name !== "string" || !namePattern.test(frame.name)) {
        throw new Error("The handoff transfer sent an invalid control file name.");
      }
      if (!Number.isInteger(frame.mode)) throw new Error("The handoff transfer sent an invalid file mode.");
      await receive(path.join(control, frame.name), frame.size, frame.mode & 0o700);
    } else {
      throw new Error("The handoff transfer sent an unknown frame.");
    }
  }
  if (expected.size > 0) throw new Error(`The handoff transfer is missing ${expected.size} profile objects.`);
  if (buffered.length > 0 || (await fill())) throw new Error("The handoff transfer sent data after its end.");
})().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
