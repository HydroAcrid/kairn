// SPDX-License-Identifier: Apache-2.0

"use strict";

// Preloaded only by the offline smoke test. Every common Node networking entry
// point is recorded before throwing so caught/retried network calls still fail
// the smoke test.
const fs = require("node:fs");

function blocked(operation) {
  return function denyKairnSmokeNetwork() {
    const message = `Blocked outbound network operation during offline smoke: ${operation}`;
    if (process.env.KAIRN_NETWORK_ATTEMPT_LOG) {
      fs.appendFileSync(process.env.KAIRN_NETWORK_ATTEMPT_LOG, `${message}\n`, "utf8");
    }
    throw new Error(message);
  };
}

function localIpcOnly(operation, original) {
  return function denyOutboundButAllowLocalIpc(...args) {
    const first = args[0];
    const options = Array.isArray(first) ? first[0] : first;
    const isLocalSocket = typeof options === "string"
      || (options && typeof options === "object" && typeof options.path === "string"
        && options.port === undefined && options.host === undefined);
    if (isLocalSocket) return Reflect.apply(original, this, args);
    return blocked(operation)();
  };
}

const net = require("node:net");
net.connect = localIpcOnly("net.connect", net.connect);
net.createConnection = localIpcOnly("net.createConnection", net.createConnection);
net.Socket.prototype.connect = localIpcOnly("net.Socket.connect", net.Socket.prototype.connect);

const tls = require("node:tls");
tls.connect = blocked("tls.connect");

for (const protocol of ["node:http", "node:https"]) {
  const client = require(protocol);
  client.request = blocked(`${protocol}.request`);
  client.get = blocked(`${protocol}.get`);
}

const dns = require("node:dns");
for (const operation of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny"]) {
  dns[operation] = blocked(`dns.${operation}`);
  if (dns.promises && typeof dns.promises[operation] === "function") {
    dns.promises[operation] = blocked(`dns.promises.${operation}`);
  }
}

const dgram = require("node:dgram");
dgram.createSocket = blocked("dgram.createSocket");
const http2 = require("node:http2");
http2.connect = blocked("http2.connect");
globalThis.fetch = blocked("fetch");
