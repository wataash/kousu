// SPDX-License-Identifier: Apache-2.0

import * as nodeFetch from "node-fetch";

// -----------------------------------------------------------------------------
// logger

// @template:error:v2

let logCb: (s: string) => void = (_s: string) => {
  // nop
};
// logging cb with stack trace
let logStackCb: (s: string) => void = (_s: string) => {
  // nop
};
export function setErrorLogCallback(cb: (s: string) => void) {
  logCb = cb;
}
export function setErrorLogStackCallback(cb: (s: string) => void) {
  logStackCb = cb;
}

// -----------------------------------------------------------------------------
// errors

export class KousuError extends Error {
  constructor(message: string, withStack = false) {
    // https://www.typescriptlang.org/docs/handbook/release-notes/typescript-2-2.html
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    if (withStack) {
      logStackCb(message);
    } else {
      logCb(message);
    }
  }
}

// @template:http-error
export class HttpError extends Error {
  constructor(resp: nodeFetch.Response, message: string, withStack = false) {
    message = `HttpError: ${message}; url:${resp.url} status:${resp.status} statusText:${resp.statusText}`;
    // https://www.typescriptlang.org/docs/handbook/release-notes/typescript-2-2.html
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    if (withStack) {
      logStackCb(message);
    } else {
      logCb(message);
    }
    resp;
  }
}
