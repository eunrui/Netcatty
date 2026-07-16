"use strict";

const sessionStrategies = new Map();
const sftpStrategies = new Map();

function normalizeStrategy(value) {
  return value === "sequential" ? "sequential" : undefined;
}

function inferSessionStrategy(payload) {
  const explicit = normalizeStrategy(payload?.sftpUploadStrategy);
  if (explicit) return explicit;
  return typeof payload?.username === "string" && payload.username.startsWith("JMS-")
    ? "sequential"
    : undefined;
}

function setSessionStrategy(sessionId, strategy) {
  if (!sessionId) return;
  const normalized = normalizeStrategy(strategy);
  if (normalized) sessionStrategies.set(sessionId, normalized);
  else sessionStrategies.delete(sessionId);
}

function getSessionStrategy(sessionId) {
  return sessionId ? sessionStrategies.get(sessionId) : undefined;
}

function clearSessionStrategy(sessionId) {
  if (sessionId) sessionStrategies.delete(sessionId);
}

function setSftpStrategy(sftpId, strategy) {
  if (!sftpId) return;
  const normalized = normalizeStrategy(strategy);
  if (normalized) sftpStrategies.set(sftpId, normalized);
  else sftpStrategies.delete(sftpId);
}

function getSftpStrategy(sftpId) {
  return sftpId ? sftpStrategies.get(sftpId) : undefined;
}

function clearSftpStrategy(sftpId) {
  if (sftpId) sftpStrategies.delete(sftpId);
}

function resetForTests() {
  sessionStrategies.clear();
  sftpStrategies.clear();
}

module.exports = {
  normalizeStrategy,
  inferSessionStrategy,
  setSessionStrategy,
  getSessionStrategy,
  clearSessionStrategy,
  setSftpStrategy,
  getSftpStrategy,
  clearSftpStrategy,
  resetForTests,
};
