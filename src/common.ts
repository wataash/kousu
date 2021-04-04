// SPDX-License-Identifier: Apache-2.0

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
export function setErrorLogCallback(cb: (s: string) => void): void {
  logCb = cb;
}
export function setErrorLogStackCallback(cb: (s: string) => void): void {
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
