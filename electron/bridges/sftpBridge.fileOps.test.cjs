const test = require("node:test");
const assert = require("node:assert/strict");

const { createFileOpsApi } = require("./sftpBridge/fileOps.cjs");
const { TRANSFER_CHUNK_SIZE } = require("./transferLimits.cjs");

function createFileOpsTestContext(client) {
  return {
    sftpClients: new Map([["sftp-1", client]]),
    electronModule: null,
    activeSftpUploads: new Map(),
    fileWatcherBridge: {},
    fs: require("node:fs"),
    path: require("node:path"),
    Buffer,
    console,
    setTimeout,
    clearTimeout,
    jumpConnectionsMap: new Map(),
    sftpEncodingState: new Map(),
    normalizeEncoding: (value) => value || "utf-8",
    isAsciiString: () => true,
    TRANSFER_CHUNK_SIZE,
    requireSftpChannel: async () => true,
    resolveEncodingForRequest: () => "utf-8",
    updateResolvedEncoding: (_sftpId, _requested, resolved) => resolved,
    encodePath: (input) => input,
    decodeName: (raw) => raw,
    detectEncodingFromList: () => null,
    statResultFromAttrs: (attrs) => attrs,
    normalizeRemotePathString: async (_client, inputPath) => inputPath,
    collectReadable: async () => Buffer.alloc(0),
    writeToWritable: async () => true,
    throwIfAborted: () => {},
    pipeStreams: async () => true,
    ensureRemoteDirForSession: async () => true,
    removeRemotePathInternal: async () => true,
    renameRemotePath: async () => true,
    realpathAsync: async () => "/",
    statAsync: async () => ({ isDirectory: () => false }),
    readdirAsync: async () => [],
    mkdirAsync: async () => true,
    rmdirAsync: async () => true,
    unlinkAsync: async () => true,
    openFileAsync: async () => "handle",
    writeFileChunkAsync: async () => true,
    closeFileAsync: async () => true,
    createAbortError: () => new Error("aborted"),
    copySftpEncodingState: () => {},
    clearSftpEncodingState: () => {},
    safeSend: () => {},
    tempDirBridge: {},
    randomUUID: () => "uuid-1",
  };
}

test("memory-backed binary upload preserves content with conservative chunks", async () => {
  const chunks = [];
  const client = {
    __netcattySftpUploadStrategy: "sequential",
    put(content) {
      return new Promise((resolve, reject) => {
        content.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        content.once("end", resolve);
        content.once("error", reject);
      });
    },
    stat() {
      return Promise.resolve({ size: Buffer.concat(chunks).length });
    },
  };
  const api = createFileOpsApi(createFileOpsTestContext(client));
  const payload = Buffer.alloc((TRANSFER_CHUNK_SIZE * 3) + 17);
  for (let index = 0; index < payload.length; index++) {
    payload[index] = index % 251;
  }

  const result = await api.writeSftpBinaryWithProgress(
    { sender: { id: 1 } },
    {
      sftpId: "sftp-1",
      path: "/tmp/archive.zip",
      content: payload,
      transferId: "memory-upload",
      onProgress() {},
      onComplete() {},
      onError() {},
    },
  );

  assert.equal(result.success, true);
  assert.deepEqual(Buffer.concat(chunks), payload);
  assert.ok(Math.max(...chunks.map((chunk) => chunk.length)) <= TRANSFER_CHUNK_SIZE);
});

test("ordinary memory-backed uploads retain the existing larger chunks", async () => {
  const chunks = [];
  const client = {
    put(content) {
      return new Promise((resolve, reject) => {
        content.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        content.once("end", resolve);
        content.once("error", reject);
      });
    },
    stat() {
      return Promise.resolve({ size: Buffer.concat(chunks).length });
    },
  };
  const api = createFileOpsApi(createFileOpsTestContext(client));
  const payload = Buffer.alloc((TRANSFER_CHUNK_SIZE * 3) + 17, 7);

  const result = await api.writeSftpBinaryWithProgress(
    { sender: { id: 1 } },
    {
      sftpId: "sftp-1",
      path: "/tmp/ordinary.bin",
      content: payload,
      transferId: "ordinary-memory-upload",
      onProgress() {},
      onComplete() {},
      onError() {},
    },
  );

  assert.equal(result.success, true);
  assert.deepEqual(Buffer.concat(chunks), payload);
  assert.ok(Math.max(...chunks.map((chunk) => chunk.length)) > TRANSFER_CHUNK_SIZE);
});
