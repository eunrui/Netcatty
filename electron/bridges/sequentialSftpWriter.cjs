"use strict";

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  if (typeof signal.reason === "string" && signal.reason) {
    throw new Error(signal.reason);
  }
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  throw error;
}

function openRemoteFile(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.open(remotePath, "w", (err, handle) => {
      if (err) reject(err);
      else resolve(handle);
    });
  });
}

function writeRemoteChunk(sftp, handle, buffer, offset, length, position) {
  return new Promise((resolve, reject) => {
    sftp.write(handle, buffer, offset, length, position, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function closeRemoteFile(sftp, handle) {
  return new Promise((resolve, reject) => {
    sftp.close(handle, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function writeSftpSequentially({
  sftp,
  remotePath,
  chunks,
  chunkSize,
  signal,
  onProgress,
}) {
  if (!sftp || typeof sftp.open !== "function" || typeof sftp.write !== "function" || typeof sftp.close !== "function") {
    throw new TypeError("SFTP client does not support direct file writes");
  }
  if (!chunks || (
    typeof chunks[Symbol.asyncIterator] !== "function"
    && typeof chunks[Symbol.iterator] !== "function"
  )) {
    throw new TypeError("chunks must be an iterable");
  }
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new TypeError("chunkSize must be a positive integer");
  }

  throwIfAborted(signal);
  const handle = await openRemoteFile(sftp, remotePath);
  let position = 0;
  let primaryError = null;

  try {
    for await (const input of chunks) {
      const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
      for (let offset = 0; offset < buffer.length; offset += chunkSize) {
        throwIfAborted(signal);
        const length = Math.min(chunkSize, buffer.length - offset);
        await writeRemoteChunk(sftp, handle, buffer, offset, length, position);
        position += length;
        onProgress?.(position);
      }
    }
    throwIfAborted(signal);
  } catch (err) {
    primaryError = err;
    throw err;
  } finally {
    try {
      await closeRemoteFile(sftp, handle);
    } catch (closeError) {
      if (!primaryError) throw closeError;
    }
  }

  return position;
}

module.exports = {
  writeSftpSequentially,
};
