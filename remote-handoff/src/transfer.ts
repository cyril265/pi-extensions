import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { constants, createGzip, type Gzip } from "node:zlib";
import { packageRoot } from "./paths.js";
import { remoteCommand, sshStream } from "./remote.js";

export type TransferSource = { path: string } | { content: Buffer };

export interface TransferFile {
  name: string;
  mode: number;
  size: number;
  source: TransferSource;
}

export interface TransferObject {
  hash: string;
  size: number;
  source: TransferSource;
}

export interface TransferRequest {
  host: string;
  control: string;
  objectStore: string;
  prelude: readonly string[];
  epilogue: readonly string[];
  files: readonly TransferFile[];
  objects: ReadonlyMap<string, TransferObject>;
  onProgress: (message: string) => void;
}

const transferScript = readFileSync(join(packageRoot, "remote", "transfer.cjs"), "utf8");
const missingPrefix = "PI_REMOTE_HANDOFF_MISSING\t";
const progressPrefix = "PI_REMOTE_HANDOFF_PROGRESS\t";
const progressIntervalMs = 200;

export async function localTransferFile(name: string, path: string, mode = 0o600): Promise<TransferFile> {
  return { name, mode, size: (await stat(path)).size, source: { path } };
}

export function contentTransferFile(name: string, content: Buffer, mode = 0o600): TransferFile {
  return { name, mode, size: content.length, source: { content } };
}

export async function packagedTransferFile(name: string, mode: number): Promise<TransferFile> {
  return contentTransferFile(name, await readFile(join(packageRoot, "remote", name)), mode);
}

function frame(value: object): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

async function write(stream: Writable, chunk: Buffer, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (!stream.write(chunk)) await once(stream, "drain", { signal });
}

function flush(gzip: Gzip): Promise<void> {
  return new Promise((resolvePromise) => gzip.flush(constants.Z_SYNC_FLUSH, () => resolvePromise()));
}

function transferSizes(sent: number, total: number): string {
  if (total < 1024 * 1024) return `${Math.ceil(sent / 1024)} of ${Math.ceil(total / 1024)} KB`;
  return `${(sent / 1024 / 1024).toFixed(1)} of ${(total / 1024 / 1024).toFixed(1)} MB`;
}

async function writeSource(
  gzip: Gzip,
  source: TransferSource,
  size: number,
  expectedHash: string | undefined,
  signal: AbortSignal,
  onBytes: (bytes: number) => void,
): Promise<void> {
  const label = "path" in source ? source.path : "Generated profile file";
  const hash = createHash("sha256");
  let written = 0;
  if ("content" in source) {
    if (source.content.length !== size) throw new Error(`${label} has an unexpected size.`);
    hash.update(source.content);
    await write(gzip, source.content, signal);
    written = size;
    onBytes(size);
  } else if (size > 0) {
    const stream = createReadStream(source.path, { start: 0, end: size - 1, highWaterMark: 1024 * 1024 });
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        hash.update(chunk);
        written += chunk.length;
        await write(gzip, chunk, signal);
        onBytes(chunk.length);
      }
    } finally {
      stream.destroy();
    }
  }
  if (written !== size || (expectedHash !== undefined && hash.digest("hex") !== expectedHash)) {
    throw new Error(`${label} changed while it was uploaded. Retry the handoff.`);
  }
}

function parseMissing(value: string, requested: ReadonlyMap<string, TransferObject>): string[] {
  const missing: unknown = JSON.parse(value);
  if (!Array.isArray(missing) || !missing.every((hash) => typeof hash === "string" && requested.has(hash))) {
    throw new Error("The remote host returned an invalid profile object list.");
  }
  return missing;
}

export async function runTransfer(request: TransferRequest): Promise<void> {
  let resolveMissing!: (hashes: string[]) => void;
  let rejectMissing!: (error: Error) => void;
  const missing = new Promise<string[]>((resolvePromise, reject) => {
    resolveMissing = resolvePromise;
    rejectMissing = reject;
  });
  missing.catch(() => {});

  const command = [
    ...request.prelude,
    remoteCommand(["node", "-e", transferScript, request.control, request.objectStore]),
    ...request.epilogue,
  ].join("\n");

  await sshStream(request.host, command, {
    onStdoutLine: (line) => {
      if (line.startsWith(missingPrefix)) {
        resolveMissing(parseMissing(line.slice(missingPrefix.length), request.objects));
      } else if (line.startsWith(progressPrefix)) {
        request.onProgress(line.slice(progressPrefix.length));
      }
    },
    writeInput: async (stdin, signal) => {
      signal.addEventListener("abort", () => rejectMissing(new Error("The handoff transfer was interrupted.")), {
        once: true,
      });
      const gzip = createGzip();
      gzip.pipe(stdin);
      await write(gzip, frame({ kind: "query", objects: [...request.objects.keys()] }), signal);
      await flush(gzip);

      const objects = (await missing).map((hash) => request.objects.get(hash)!);
      const total = objects.reduce((sum, object) => sum + object.size, 0)
        + request.files.reduce((sum, file) => sum + file.size, 0);
      const newFiles = objects.length > 0 ? `, ${objects.length} new profile files` : "";
      let sent = 0;
      let reported = 0;
      const report = (force = false) => {
        const now = Date.now();
        if (!force && now - reported < progressIntervalMs) return;
        reported = now;
        request.onProgress(`Uploading ${transferSizes(sent, total)}${newFiles}`);
      };
      const onBytes = (bytes: number) => {
        sent += bytes;
        report();
      };
      report(true);

      for (const object of objects) {
        await write(gzip, frame({ kind: "object", hash: object.hash, size: object.size }), signal);
        await writeSource(gzip, object.source, object.size, object.hash, signal, onBytes);
      }
      for (const file of request.files) {
        await write(gzip, frame({ kind: "file", name: file.name, mode: file.mode, size: file.size }), signal);
        await writeSource(gzip, file.source, file.size, undefined, signal, onBytes);
      }
      await write(gzip, frame({ kind: "end" }), signal);
      report(true);
      gzip.end();
    },
  });
}
