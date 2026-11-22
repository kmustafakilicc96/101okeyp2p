/**
 * network.js
 * Backwards-compatibility shim that exposes LocalWsTransport / OkeyTransport.
 */
(function (root) {
  'use strict';
  if (root.OkeyTransport) {
    root.P2PNetwork = root.OkeyTransport.LocalWsTransport;
  }
})(typeof self !== 'undefined' ? self : this);
