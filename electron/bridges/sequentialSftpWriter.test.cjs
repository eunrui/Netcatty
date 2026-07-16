const test = require("node:test");
const assert = require("node:assert/strict");
const { writeSftpSequentially } = require("./sequentialSftpWriter.cjs");

function createFakeSftp(options = {}) {
  const remote = Buffer.alloc(options.remoteSize || 256 * 1024);
  let inFlightWrites = 0;
  let maxInFlightWrites = 0;
  let writeCalls = 0;
  let closed = false;

  return {
    remote,
    get maxInFlightWrites() { return maxInFlightWrites; },
    get writeCalls() { return writeCalls; },
    get closed() { return closed; },
    open(_remotePath, flags, callback) {
      assert.equal(flags, "w");
      callback(null, Buffer.from("handle"));
    },
    write(_handle, buffer, offset, length, position, callback) {
      writeCalls += 1;
      const callNumber = writeCalls;
      inFlightWrites += 1;
      maxInFlightWrites = Math.max(maxInFlightWrites, inFlightWrites);
      setImmediate(() => {
        inFlightWrites -= 1;
        if (options.failWriteAt === callNumber) {
          callback(new Error("simulated write failure"));
          return;
        }
        buffer.copy(remote, position, offset, offset + length);
        callback(null);
      });
    },
    close(_handle, callback) {
      closed = true;
      callback(options.closeError || null);
    },
  };
}

function createPayload(size) {
  const payload = Buffer.alloc(size);
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = (index * 29) % 251;
  }
  return payload;
}

test("writeSftpSequentially keeps exactly one positioned write in flight", async () => {
  const payload = createPayload((32 * 1024 * 4) + 19);
  const sftp = createFakeSftp({ remoteSize: payload.length });
  const progress = [];

  const written = await writeSftpSequentially({
    sftp,
    remotePath: "/tmp/archive.tar.gz",
    chunks: [payload.subarray(0, 70000), payload.subarray(70000)],
    chunkSize: 32 * 1024,
    onProgress: (bytes) => progress.push(bytes),
  });

  assert.equal(written, payload.length);
  assert.equal(sftp.maxInFlightWrites, 1);
  assert.equal(sftp.closed, true);
  assert.deepEqual(sftp.remote, payload);
  assert.equal(progress.at(-1), payload.length);
});

test("writeSftpSequentially stops after a write failure and closes the handle", async () => {
  const payload = createPayload(96 * 1024);
  const sftp = createFakeSftp({ remoteSize: payload.length, failWriteAt: 2 });

  await assert.rejects(
    writeSftpSequentially({
      sftp,
      remotePath: "/tmp/archive.zip",
      chunks: [payload],
      chunkSize: 32 * 1024,
    }),
    /simulated write failure/,
  );

  assert.equal(sftp.writeCalls, 2);
  assert.equal(sftp.maxInFlightWrites, 1);
  assert.equal(sftp.closed, true);
});

test("writeSftpSequentially does not start another write after cancellation", async () => {
  const payload = createPayload(96 * 1024);
  const sftp = createFakeSftp({ remoteSize: payload.length });
  const controller = new AbortController();

  await assert.rejects(
    writeSftpSequentially({
      sftp,
      remotePath: "/tmp/archive.zip",
      chunks: [payload],
      chunkSize: 32 * 1024,
      signal: controller.signal,
      onProgress() {
        controller.abort(new Error("cancelled by test"));
      },
    }),
    /cancelled by test/,
  );

  assert.equal(sftp.writeCalls, 1);
  assert.equal(sftp.closed, true);
});
