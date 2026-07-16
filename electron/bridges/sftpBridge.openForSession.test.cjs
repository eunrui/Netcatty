const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");

const sftpBridge = require("./sftpBridge.cjs");

test("openSftpForSession infers sequential uploads from the JumpServer username", async () => {
  const channel = new EventEmitter();
  channel.end = () => {};
  channel.readdir = (_path, callback) => callback(null, []);
  channel.stat = (_path, callback) => callback(null, { size: 0 });
  channel.mkdir = (_path, callback) => callback(null);
  channel.unlink = (_path, callback) => callback(null);
  const conn = {
    _sock: { destroyed: false },
    sftp(callback) {
      callback(null, channel);
    },
  };
  const sessions = new Map([["terminal-1", {
    conn,
    connRef: { count: 1, conn, chainConnections: [] },
    _reuseEndpoint: { username: "JMS-token-id" },
  }]]);
  const clients = new Map();
  sftpBridge.init({ sessions, sftpClients: clients, electronModule: {} });

  const result = await sftpBridge.openSftpForSession({}, { sessionId: "terminal-1" });
  const client = clients.get(result.sftpId);

  assert.equal(client.__netcattySftpUploadStrategy, "sequential");
  await client.end();
});

test("session-backed JumpServer put keeps one direct SFTP write in flight", async () => {
  const payload = Buffer.alloc((96 * 1024) + 11);
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = (index * 31) % 251;
  }

  const remoteBytes = Buffer.alloc(payload.length);
  let inFlightWrites = 0;
  let maxInFlightWrites = 0;
  let closed = false;
  const channel = new EventEmitter();
  channel.end = () => {};
  channel.readdir = (_path, callback) => callback(null, []);
  channel.stat = (_path, callback) => callback(null, { size: remoteBytes.length });
  channel.mkdir = (_path, callback) => callback(null);
  channel.unlink = (_path, callback) => callback(null);
  channel.createWriteStream = () => {
    throw new Error("sequential put must not use createWriteStream");
  };
  channel.open = (_path, flags, callback) => {
    assert.equal(flags, "w");
    callback(null, Buffer.from("handle"));
  };
  channel.write = (_handle, buffer, offset, length, position, callback) => {
    inFlightWrites += 1;
    maxInFlightWrites = Math.max(maxInFlightWrites, inFlightWrites);
    setImmediate(() => {
      buffer.copy(remoteBytes, position, offset, offset + length);
      inFlightWrites -= 1;
      callback(null);
    });
  };
  channel.close = (_handle, callback) => {
    closed = true;
    callback(null);
  };

  const conn = {
    _sock: { destroyed: false },
    sftp(callback) {
      callback(null, channel);
    },
  };
  const sessions = new Map([["terminal-2", {
    conn,
    connRef: { count: 1, conn, chainConnections: [] },
    sftpUploadStrategy: "sequential",
  }]]);
  const clients = new Map();
  sftpBridge.init({ sessions, sftpClients: clients, electronModule: {} });

  const result = await sftpBridge.openSftpForSession({}, { sessionId: "terminal-2" });
  const client = clients.get(result.sftpId);
  await client.put(
    Readable.from([payload.subarray(0, 50000), payload.subarray(50000)]),
    "/tmp/archive.tar.gz",
  );

  assert.equal(maxInFlightWrites, 1);
  assert.equal(closed, true);
  assert.deepEqual(remoteBytes, payload);
  await client.end();
});
