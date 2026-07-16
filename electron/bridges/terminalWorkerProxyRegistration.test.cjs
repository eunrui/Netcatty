const assert = require("node:assert/strict");
const test = require("node:test");

const terminalBridge = require("./terminalBridge.cjs");
const sshBridge = require("./sshBridge.cjs");
const sftpBridge = require("./sftpBridge.cjs");
const transferBridge = require("./transferBridge.cjs");
const compressUploadBridge = require("./compressUploadBridge.cjs");
const fileWatcherBridge = require("./fileWatcherBridge.cjs");
const sftpUploadStrategyRegistry = require("./sftpUploadStrategyRegistry.cjs");
const { createSystemManagerBridge } = require("./systemManagerBridge.cjs");

test.beforeEach(() => {
  sftpUploadStrategyRegistry.resetForTests();
});

function createFakeIpcMain() {
  return {
    handlers: new Map(),
    listeners: new Map(),
    handle(channel, handler) {
      this.handlers.set(channel, handler);
    },
    on(channel, listener) {
      this.listeners.set(channel, listener);
    },
  };
}

function createFakeWorkerManager() {
  const requests = [];
  const sends = [];
  return {
    requests,
    sends,
    request(channel, payload, options) {
      requests.push({ channel, payload, options });
      return Promise.resolve({ ok: true, channel });
    },
    send(channel, payload, options) {
      sends.push({ channel, payload, options });
    },
  };
}

const fakeEvent = { sender: { id: 42 } };

test("terminal worker mode proxies all terminal starts and control commands", async () => {
  const ipcMain = createFakeIpcMain();
  const terminalWorkerManager = createFakeWorkerManager();

  terminalBridge.registerHandlers(ipcMain, { terminalWorkerManager });

  for (const channel of [
    "netcatty:local:start",
    "netcatty:telnet:start",
    "netcatty:mosh:start",
    "netcatty:et:start",
    "netcatty:serial:start",
  ]) {
    assert.equal(ipcMain.handlers.has(channel), true, `${channel} should be proxied as a request`);
    await ipcMain.handlers.get(channel)(fakeEvent, { sessionId: channel });
  }

  for (const channel of [
    "netcatty:write",
    "netcatty:interrupt",
    "netcatty:resize",
    "netcatty:flow",
    "netcatty:flow:ack",
    "netcatty:close",
  ]) {
    assert.equal(ipcMain.listeners.has(channel), true, `${channel} should be proxied as a send`);
    ipcMain.listeners.get(channel)(fakeEvent, { sessionId: channel });
  }

  assert.deepEqual(
    terminalWorkerManager.requests.map((entry) => entry.channel),
    [
      "netcatty:local:start",
      "netcatty:telnet:start",
      "netcatty:mosh:start",
      "netcatty:et:start",
      "netcatty:serial:start",
    ],
  );
  assert.deepEqual(
    terminalWorkerManager.sends.map((entry) => entry.channel),
    [
      "netcatty:write",
      "netcatty:interrupt",
      "netcatty:resize",
      "netcatty:flow",
      "netcatty:flow:ack",
      "netcatty:close",
    ],
  );
});

test("terminal worker mode proxies SSH session and remote helper requests", async () => {
  const ipcMain = createFakeIpcMain();
  const terminalWorkerManager = createFakeWorkerManager();

  sshBridge.registerHandlers(ipcMain, { terminalWorkerManager });

  for (const channel of [
    "netcatty:start",
    "netcatty:ssh:exec",
    "netcatty:ssh:pwd",
    "netcatty:ssh:remoteInfo",
    "netcatty:ssh:distroInfo",
    "netcatty:ssh:readRemoteHistory",
    "netcatty:ssh:listdir",
    "netcatty:ssh:stats",
    "netcatty:ssh:setEncoding",
  ]) {
    assert.equal(ipcMain.handlers.has(channel), true, `${channel} should be proxied`);
    await ipcMain.handlers.get(channel)(fakeEvent, { sessionId: "ssh-1" });
  }

  assert.deepEqual(
    terminalWorkerManager.requests.map((entry) => entry.channel),
    [
      "netcatty:start",
      "netcatty:ssh:exec",
      "netcatty:ssh:pwd",
      "netcatty:ssh:remoteInfo",
      "netcatty:ssh:distroInfo",
      "netcatty:ssh:readRemoteHistory",
      "netcatty:ssh:listdir",
      "netcatty:ssh:stats",
      "netcatty:ssh:setEncoding",
    ],
  );
});

test("terminal worker mode proxies SFTP and surrounding file operations", async () => {
  const ipcMain = createFakeIpcMain();
  const terminalWorkerManager = createFakeWorkerManager();

  sftpBridge.registerHandlers(ipcMain, { terminalWorkerManager });
  transferBridge.registerHandlers(ipcMain, { terminalWorkerManager });
  compressUploadBridge.registerHandlers(ipcMain, { terminalWorkerManager });
  fileWatcherBridge.registerHandlers(ipcMain, { terminalWorkerManager });

  for (const channel of [
    "netcatty:sftp:openForSession",
    "netcatty:sftp:list",
    "netcatty:sftp:write",
    "netcatty:sftp:downloadToLocal",
    "netcatty:sftp:uploadLocal",
    "netcatty:sftp:close",
    "netcatty:transfer:start",
    "netcatty:transfer:cancel",
    "netcatty:compress:start",
    "netcatty:compress:checkSupport",
    "netcatty:filewatch:start",
    "netcatty:filewatch:registerTempFile",
  ]) {
    assert.equal(ipcMain.handlers.has(channel), true, `${channel} should be proxied`);
    await ipcMain.handlers.get(channel)(fakeEvent, { sessionId: "ssh-1", sftpId: "sftp-1" });
  }

  assert.deepEqual(
    terminalWorkerManager.requests.map((entry) => entry.channel),
    [
      "netcatty:sftp:openForSession",
      "netcatty:sftp:list",
      "netcatty:sftp:write",
      "netcatty:sftp:downloadToLocal",
      "netcatty:sftp:uploadLocal",
      "netcatty:sftp:close",
      "netcatty:transfer:start",
      "netcatty:transfer:cancel",
      "netcatty:compress:start",
      "netcatty:compress:checkSupport",
      "netcatty:filewatch:start",
      "netcatty:filewatch:registerTempFile",
    ],
  );
});

test("terminal worker mode propagates sequential uploads from a marked deep-link SSH session", async () => {
  const ipcMain = createFakeIpcMain();
  const terminalWorkerManager = createFakeWorkerManager();
  terminalWorkerManager.request = function request(channel, payload, options) {
    this.requests.push({ channel, payload, options });
    if (channel === "netcatty:sftp:open") {
      return Promise.resolve({ sftpId: "sftp-jms" });
    }
    return Promise.resolve({ ok: true, channel });
  };

  sshBridge.registerHandlers(ipcMain, { terminalWorkerManager });
  terminalBridge.registerHandlers(ipcMain, { terminalWorkerManager });
  sftpBridge.registerHandlers(ipcMain, { terminalWorkerManager });
  transferBridge.registerHandlers(ipcMain, { terminalWorkerManager });

  await ipcMain.handlers.get("netcatty:start")(fakeEvent, {
    sessionId: "ssh-deep-link",
    username: "appuser",
    sftpUploadStrategy: "sequential",
  });
  await ipcMain.handlers.get("netcatty:sftp:open")(fakeEvent, {
    sessionId: "sftp-request",
    sourceSessionId: "ssh-deep-link",
    reuseOnly: true,
  });
  await ipcMain.handlers.get("netcatty:transfer:start")(fakeEvent, {
    transferId: "transfer-jms",
    sourceType: "local",
    targetType: "sftp",
    targetSftpId: "sftp-jms",
  });

  assert.equal(terminalWorkerManager.requests[0].payload.sftpUploadStrategy, "sequential");
  assert.equal(terminalWorkerManager.requests[1].payload.sftpUploadStrategy, "sequential");
  assert.equal(terminalWorkerManager.requests[2].payload.targetUploadStrategy, "sequential");

  ipcMain.listeners.get("netcatty:close")(fakeEvent, { sessionId: "ssh-deep-link" });
  assert.equal(sftpUploadStrategyRegistry.getSessionStrategy("ssh-deep-link"), undefined);

  await ipcMain.handlers.get("netcatty:sftp:close")(fakeEvent, { sftpId: "sftp-jms" });
  await ipcMain.handlers.get("netcatty:transfer:start")(fakeEvent, {
    transferId: "transfer-after-close",
    sourceType: "local",
    targetType: "sftp",
    targetSftpId: "sftp-jms",
  });
  assert.equal(terminalWorkerManager.requests[4].payload.targetUploadStrategy, undefined);
});

test("terminal worker mode leaves ordinary SSH-backed SFTP uploads unmarked", async () => {
  const ipcMain = createFakeIpcMain();
  const terminalWorkerManager = createFakeWorkerManager();
  terminalWorkerManager.request = function request(channel, payload, options) {
    this.requests.push({ channel, payload, options });
    if (channel === "netcatty:sftp:openForSession") {
      return Promise.resolve({ ok: true, sftpId: "sftp-ordinary" });
    }
    return Promise.resolve({ ok: true, channel });
  };

  sshBridge.registerHandlers(ipcMain, { terminalWorkerManager });
  sftpBridge.registerHandlers(ipcMain, { terminalWorkerManager });
  transferBridge.registerHandlers(ipcMain, { terminalWorkerManager });

  await ipcMain.handlers.get("netcatty:start")(fakeEvent, {
    sessionId: "ssh-ordinary",
    username: "appuser",
  });
  await ipcMain.handlers.get("netcatty:sftp:openForSession")(fakeEvent, {
    sessionId: "ssh-ordinary",
  });
  await ipcMain.handlers.get("netcatty:transfer:start")(fakeEvent, {
    transferId: "transfer-ordinary",
    sourceType: "local",
    targetType: "sftp",
    targetSftpId: "sftp-ordinary",
  });

  assert.equal(terminalWorkerManager.requests[1].payload.sftpUploadStrategy, undefined);
  assert.equal(terminalWorkerManager.requests[2].payload.targetUploadStrategy, undefined);
});

test("terminal worker mode proxies system management requests", async () => {
  const ipcMain = createFakeIpcMain();
  const terminalWorkerManager = createFakeWorkerManager();
  const systemManagerBridge = createSystemManagerBridge({
    getSessions: () => new Map(),
    execOnEtSession: () => {},
    ensureMoshStatsConnection: () => {},
    process,
  });

  systemManagerBridge.registerHandlers(ipcMain, { terminalWorkerManager });

  for (const channel of [
    "netcatty:system:probeCapabilities",
    "netcatty:system:listProcesses",
    "netcatty:system:setupOsc7Tracking",
    "netcatty:system:listTmuxSessions",
    "netcatty:system:listDockerContainers",
  ]) {
    assert.equal(ipcMain.handlers.has(channel), true, `${channel} should be proxied`);
    await ipcMain.handlers.get(channel)(fakeEvent, { sessionId: "ssh-1" });
  }

  assert.deepEqual(
    terminalWorkerManager.requests.map((entry) => entry.channel),
    [
      "netcatty:system:probeCapabilities",
      "netcatty:system:listProcesses",
      "netcatty:system:setupOsc7Tracking",
      "netcatty:system:listTmuxSessions",
      "netcatty:system:listDockerContainers",
    ],
  );
});
