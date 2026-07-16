const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

function loadOpenConnectionWithSftpClient(SftpClient) {
  const openConnectionPath = require.resolve("./sftpBridge/openConnection.cjs");
  delete require.cache[openConnectionPath];

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "ssh2-sftp-client") {
      return SftpClient;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[openConnectionPath];
    return require("./sftpBridge/openConnection.cjs");
  } finally {
    Module._load = originalLoad;
  }
}

function createReuseOnlyApi({
  findReusableSession,
  createSessionBackedSftpClient,
  SftpClient,
  requireSftpChannel = async () => {},
  sftpClients = new Map(),
}) {
  const { createOpenConnectionApi } = loadOpenConnectionWithSftpClient(SftpClient);
  return createOpenConnectionApi({
    SftpClient,
    sessions: new Map(),
    findReusableSession,
    acquireConnectionRef: () => {},
    createSessionBackedSftpClient,
    requireSftpChannel,
    sendSftpProgress: () => {},
    sftpClients,
    randomUUID: () => "conn-1",
    findAllDefaultPrivateKeysFromHelper: async () => [],
    getAvailableAgentSocket: async () => null,
    hasUsableProxy: () => false,
    buildSftpAlgorithms: () => ({}),
    hostKeyVerifier: { createHostVerifier: () => () => true },
    loadFirstIdentityFileForAuth: async () => null,
    preparePrivateKeyForAuth: async () => null,
    buildAuthHandler: () => ({}),
    applyAuthToConnOpts: () => {},
    createKeyboardInteractiveHandler: () => () => {},
  });
}

test("openSftp with reuseOnly throws instead of dialing fresh when source is missing", async () => {
  let dialedFresh = false;
  class TrackingSftpClient {
    constructor() {
      dialedFresh = true;
    }
  }

  const api = createReuseOnlyApi({
    findReusableSession: () => null,
    createSessionBackedSftpClient: () => {
      throw new Error("should not create reused client");
    },
    SftpClient: TrackingSftpClient,
  });

  await assert.rejects(
    () => api.openSftp(
      { sender: { id: 1, isDestroyed: () => false, send: () => {} } },
      {
        sessionId: "sftp-1",
        hostname: "example.test",
        username: "alice",
        port: 22,
        sourceSessionId: "missing",
        reuseOnly: true,
      },
    ),
    /not reusable/,
  );
  assert.equal(dialedFresh, false);
});

test("openSftp with reuseOnly does not require renderer endpoint to match", async () => {
  let requestedTarget;
  let sessionBackedOptions;
  const source = {
    conn: { _sock: { destroyed: false } },
    connRef: { id: "ref-1" },
    _reuseEndpoint: { username: "JMS-token-id" },
  };
  const reusedClient = {
    end: async () => {},
  };

  const api = createReuseOnlyApi({
    findReusableSession: (_sessions, sourceSessionId, target) => {
      assert.equal(sourceSessionId, "live-session");
      requestedTarget = target;
      return source;
    },
    createSessionBackedSftpClient: (_id, _conn, options) => {
      sessionBackedOptions = options;
      return reusedClient;
    },
    SftpClient: class {
      constructor() {
        throw new Error("should not dial fresh");
      }
    },
  });

  const result = await api.openSftp(
    { sender: { id: 1, isDestroyed: () => false, send: () => {} } },
    {
      sessionId: "sftp-1",
      hostname: "stale.example.test",
      username: "stale-user",
      port: 2222,
      sourceSessionId: "live-session",
      reuseOnly: true,
    },
  );

  assert.equal(requestedTarget, undefined);
  assert.equal(sessionBackedOptions?.sftpUploadStrategy, "sequential");
  assert.deepEqual(result, { sftpId: "sftp-1" });
});

test("openSftp reuse prefers the explicit renderer upload strategy", async () => {
  let sessionBackedOptions;
  const source = {
    conn: { _sock: { destroyed: false } },
    connRef: { id: "ref-explicit" },
    _reuseEndpoint: { username: "appuser" },
  };

  const api = createReuseOnlyApi({
    findReusableSession: () => source,
    createSessionBackedSftpClient: (_id, _conn, options) => {
      sessionBackedOptions = options;
      return { end: async () => {} };
    },
    SftpClient: class {
      constructor() {
        throw new Error("should not dial fresh");
      }
    },
  });

  await api.openSftp(
    { sender: { id: 1, isDestroyed: () => false, send: () => {} } },
    {
      sessionId: "sftp-explicit",
      hostname: "target.example.test",
      username: "appuser",
      port: 22,
      sourceSessionId: "live-explicit",
      reuseOnly: true,
      sftpUploadStrategy: "sequential",
    },
  );

  assert.equal(sessionBackedOptions?.sftpUploadStrategy, "sequential");
});

test("openSftp reuse restores strategy from the shared SSH connection", async () => {
  let sessionBackedOptions;
  const source = {
    conn: {
      _sock: { destroyed: false },
      __netcattySftpUploadStrategy: "sequential",
    },
    connRef: { id: "ref-connection-strategy" },
    _reuseEndpoint: { username: "appuser" },
  };

  const api = createReuseOnlyApi({
    findReusableSession: () => source,
    createSessionBackedSftpClient: (_id, _conn, options) => {
      sessionBackedOptions = options;
      return { end: async () => {} };
    },
    SftpClient: class {
      constructor() {
        throw new Error("should not dial fresh");
      }
    },
  });

  await api.openSftp(
    { sender: { id: 1, isDestroyed: () => false, send: () => {} } },
    {
      sessionId: "sftp-connection-strategy",
      hostname: "target.example.test",
      username: "appuser",
      port: 22,
      sourceSessionId: "live-connection-strategy",
      reuseOnly: true,
    },
  );

  assert.equal(sessionBackedOptions?.sftpUploadStrategy, "sequential");
});

test("fresh fallback inherits upload strategy from the selected live session", async () => {
  const source = {
    conn: { _sock: { destroyed: false } },
    connRef: { id: "ref-1" },
    sftpUploadStrategy: "sequential",
  };
  const sftpClients = new Map();
  const channel = new EventEmitter();

  class FreshSftpClient extends EventEmitter {
    constructor() {
      super();
      this.client = new EventEmitter();
      this.client.connect = () => queueMicrotask(() => this.client.emit("ready"));
      this.client.sftp = (callback) => callback(null, channel);
    }
  }

  const api = createReuseOnlyApi({
    findReusableSession: () => source,
    createSessionBackedSftpClient: () => ({ end: async () => {} }),
    requireSftpChannel: async () => {
      throw new Error("simulated reuse channel failure");
    },
    SftpClient: FreshSftpClient,
    sftpClients,
  });

  const result = await api.openSftp(
    { sender: { id: 1, isDestroyed: () => false, send: () => {} } },
    {
      sessionId: "sftp-fallback",
      hostname: "jumpserver.example.test",
      username: "JMS-token-id",
      password: "token",
      port: 22,
      sourceSessionId: "live-session",
    },
  );

  assert.deepEqual(result, { sftpId: "sftp-fallback" });
  assert.equal(
    sftpClients.get("sftp-fallback")?.__netcattySftpUploadStrategy,
    "sequential",
  );
});

test("selected JMS fallback infers strategy when worker lacks source session metadata", async () => {
  const sftpClients = new Map();
  const channel = new EventEmitter();

  class FreshSftpClient extends EventEmitter {
    constructor() {
      super();
      this.client = new EventEmitter();
      this.client.connect = () => queueMicrotask(() => this.client.emit("ready"));
      this.client.sftp = (callback) => callback(null, channel);
    }
  }

  const api = createReuseOnlyApi({
    findReusableSession: () => null,
    createSessionBackedSftpClient: () => {
      throw new Error("should not create reused client");
    },
    SftpClient: FreshSftpClient,
    sftpClients,
  });

  await api.openSftp(
    { sender: { id: 1, isDestroyed: () => false, send: () => {} } },
    {
      sessionId: "sftp-worker-fallback",
      hostname: "jumpserver.example.test",
      username: "JMS-token-id",
      password: "token",
      port: 22,
      sourceSessionId: "live-session-not-mirrored",
    },
  );

  assert.equal(
    sftpClients.get("sftp-worker-fallback")?.__netcattySftpUploadStrategy,
    "sequential",
  );
});
