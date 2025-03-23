// SPDX-FileCopyrightText: Copyright (c) 2022-2025 Wataru Ashihara <wataash0607@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// based on https://github.com/wataash/scraps/blob/master/logger.ts

import assert from "assert"; // in babel: replaced with: import assert from "power-assert";

import * as path from "node:path";
import * as util from "node:util";

import StackTrace from "stacktrace-js";

enum _Level {
  Silent,
  Error,
  Warn,
  Info,
  Debug,
}

export class Logger {
  static readonly Level = _Level;
  level: _Level;

  stackTraceFilter = (frame: StackTrace.StackFrame): boolean => {
    /*
tsx logger.tsx
      at Logger.error (/home/wsh/qjs/tesjs/s/logger.ts:69:10)
      at <anonymous> (/home/wsh/qjs/tesjs/s/logger.ts:116:10)
      at ModuleJob.run (node:internal/modules/esm/module_job:271:25)
      at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:547:26)
      at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:116:5)
     */
    if (frame.fileName?.startsWith("node:")) {
      return false;
    }
    if (frame.fileName?.includes("/node_modules/")) {
      return false;
    }
    return true;
  };

  constructor(opts?: { readonly level?: _Level; readonly stackTraceFilter?: (frame: StackTrace.StackFrame) => boolean }) {
    const opts_ = opts ? { ...opts } : {};
    opts_.level ??= Logger.Level.Debug;
    this.level = opts_.level;
    opts_.stackTraceFilter ??= this.stackTraceFilter;
    this.stackTraceFilter = opts_.stackTraceFilter;
  }

  static #consoleStdErrNoWrap = new console.Console({ stdout: process.stderr, inspectOptions: { breakLength: Infinity } });

  // 2006-01-02 15:04:05 [E][func:42] msg
  #_log(level: _Level, ...params: Parameters<typeof util.format>): void {
    if (this.level < level) return;

    const stack = StackTrace.getSync();
    // assert.ok(stack[0].functionName === "#_log"); // node logger.js
    // assert.ok(stack[0].functionName === "#_log"); // node --enable-source-maps --import @power-assert/node ~/qjs/tesjs/d/logger.js
    // assert.ok(stack[1].functionName === "Logger.error");
    assert.ok(stack[2] !== undefined);
    const fnLines_ = []; // ["logger.js:func:42", "logger.js:42"]
    for (const frame of stack.slice(2).reverse()) {
      if (!this.stackTraceFilter(frame)) {
        continue;
      }
      let fileColon = `${path.basename(frame.fileName ?? "?")}:`;
      if (fileColon === "cli.ts:") fileColon = "";
      const FnColon = (() => {
        if (frame.functionName === undefined) return "";
        if (frame.functionName === "<anonymous>") return "():";
        // Class.<anonymous>
        // const baseRegex = /[$_\p{ID_Start}][$_\u200C\u200D\p{ID_Continue}]*/u; // https://github.com/sindresorhus/identifier-regex/blob/main/index.js Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)
        const re = /^([$_\p{ID_Start}][$_\u200C\u200D\p{ID_Continue}]*)\.<anonymous>$/u; // https://github.com/sindresorhus/identifier-regex/blob/main/index.js Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)
        const match = frame.functionName.match(re);
        if (match !== null) {
          return `:${match[1]}.()`;
        }
        return `${frame.functionName}:`;
      })();
      fnLines_.push(`${fileColon}${FnColon}${frame.lineNumber}`);
    }
    const fnLines = `[${fnLines_.join("][")}]`;

    assert.ok(level !== _Level.Silent);
    ({
      [Logger.Level.Error]: (...params: unknown[]) => Logger.#consoleStdErrNoWrap.error(utilStyleText("red", `${new Date().toLocaleString("sv-SE")} [E]${fnLines}`, { stream: process.stderr }), ...params),
      [Logger.Level.Warn]: (...params: unknown[]) => Logger.#consoleStdErrNoWrap.warn(utilStyleText("yellow", `${new Date().toLocaleString("sv-SE")} [W]${fnLines}`, { stream: process.stderr }), ...params),
      [Logger.Level.Info]: (...params: unknown[]) => Logger.#consoleStdErrNoWrap.info(utilStyleText("blue", `${new Date().toLocaleString("sv-SE")} [I]${fnLines}`, { stream: process.stderr }), ...params),
      [Logger.Level.Debug]: (...params: unknown[]) => Logger.#consoleStdErrNoWrap.log(utilStyleText("white", `${new Date().toLocaleString("sv-SE")} [D]${fnLines}`, { stream: process.stderr }), ...params),
    })[level](...params);
  }

  error(...params: Parameters<typeof util.format>): void {
    this.#_log(Logger.Level.Error, ...params);
  }

  warn(...params: Parameters<typeof util.format>): void {
    this.#_log(Logger.Level.Warn, ...params);
  }

  info(...params: Parameters<typeof util.format>): void {
    this.#_log(Logger.Level.Info, ...params);
  }

  debug(...params: Parameters<typeof util.format>): void {
    this.#_log(Logger.Level.Debug, ...params);
  }

  // error() with stack trace
  errors(...params: Parameters<typeof util.format>): void {
    const stack = StackTrace.getSync();
    this.#_log(Logger.Level.Error, ...params, "\n" + stack.map((frame) => frame.source).join("\n"));
  }

  warns(...params: Parameters<typeof util.format>): void {
    const stack = StackTrace.getSync();
    this.#_log(Logger.Level.Warn, ...params, "\n" + stack.map((frame) => frame.source).join("\n"));
  }
}

// eslint-disable-next-line no-constant-condition
if (0) {
  const logger = new Logger();
  assert.ok(logger.level === Logger.Level.Debug);

  const obj = [42, "a", { foo: ["bar"] }];

  console.log("-".repeat(20));
  console.log("[Logger.Level.Silent]");
  logger.level = Logger.Level.Silent;
  logger.debug("debug() NOT SHOWN", obj);
  logger.info("info() NOT SHOWN", obj);
  logger.warn("warn() NOT SHOWN", obj);
  logger.error("error() NOT SHOWN", obj);

  console.log("-".repeat(20));
  console.log("[Logger.Level.Error]");
  logger.level = Logger.Level.Error;
  logger.debug("debug() NOT SHOWN", obj);
  logger.info("info() NOT SHOWN", obj);
  logger.warn("warn() NOT SHOWN", obj);
  logger.error("error()", obj);

  console.log("-".repeat(20));
  console.log("[Logger.Level.Warn]");
  logger.level = Logger.Level.Warn;
  logger.debug("debug() NOT SHOWN", obj);
  logger.info("info() NOT SHOWN", obj);
  logger.warn("warn()", obj);
  logger.error("error()", obj);

  console.log("-".repeat(20));
  console.log("[Logger.Level.Info]");
  logger.level = Logger.Level.Info;
  logger.debug("debug() NOT SHOWN", obj);
  logger.info("info()", obj);
  logger.warn("warn()", obj);
  logger.error("error()", obj);

  console.log("-".repeat(20));
  console.log("[Logger.Level.Debug]");
  logger.level = Logger.Level.Debug;
  logger.debug("debug()", obj);
  logger.info("info()", obj);
  logger.warn("warn()", obj);
  logger.error("error()", obj);

  console.log("-".repeat(20));
  console.log("errors()");
  logger.errors("errors()");
  logger.errors("errors()", obj);
  logger.warns("warns()", obj);
}

// >= Node.js v20
export function streamShouldColorize(stream: NodeJS.WriteStream): boolean {
  // https://github.com/nodejs/node/blob/v22.13.0/lib/util.js styleText()
  // https://github.com/nodejs/node/blob/v22.13.0/lib/internal/util/colors.js shouldColorize()
  // @ts-expect-error util.d.ts is wrong
  return util.styleText("reset", "", { stream }) !== "";
}

export function shouldColorizeWithoutUtilStyleText(stream: NodeJS.WriteStream): boolean {
  // https://github.com/nodejs/node/blob/v22.13.0/lib/util.js styleText()
  // https://github.com/nodejs/node/blob/v22.13.0/lib/internal/util/colors.js shouldColorize()
  if (process.env.FORCE_COLOR !== undefined) {
    // https://github.com/nodejs/node/blob/v22.13.0/lib/internal/tty.js getColorDepth()
    if (["", "1", "true", "2", "3"].includes(process.env.FORCE_COLOR)) return true;
    return false; // any string, including: "true", "on", "foo", and even: "0", "false", "off"
  }
  if (!stream.isTTY) return false;
  // I think this is always true
  if (typeof stream.getColorDepth === "function") {
    return stream.getColorDepth() > 2;
  }
  // unreachable?
  return false;
}

export function utilStyleText(format: "red" | "yellow" | "blue" | "white", text: string, opts: { stream: NodeJS.WriteStream } = { stream: process.stdout }): string {
  if (!shouldColorizeWithoutUtilStyleText(opts?.stream)) return text;
  return `\x1b[${{ red: 31, yellow: 33, blue: 34, white: 37 }[format]}m${text}\x1b[0m`;
}
