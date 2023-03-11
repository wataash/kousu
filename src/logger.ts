// SPDX-FileCopyrightText: Copyright (c) 2022-2023 Wataru Ashihara <wataash0607@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import * as tty from "node:tty";
import * as util from "node:util";

import StackTrace from "stacktrace-js";

// -----------------------------------------------------------------------------
// lib

// 2006-01-02 15:04:05
function dateString(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function stackTraceStack(stack?: string): string | null {
  if (stack === undefined) {
    console.error("stackTraceStack(): stack is undefined");
    return null;
  }
  const origStack = stack;
  for (;;) {
    if (stringFirstLine(stack) === "Error") {
      return stringRemoveFirstLine(stack);
    }
    stack = stringRemoveFirstLine(stack);
    if (stack === "") {
      console.error(`stackTraceStack(): unexpected format of stack: ${origStack}`);
      return "";
    }
  }
}

function stringFirstLine(s: string): string {
  const i = s.indexOf("\n");
  if (i === -1) return s;
  if (i === 0) return ""; // "\n..."
  // s.at(): es2022
  // if (s.at(i - 1) === "\r") return s.slice(0, i - 1); // "...\r\n..."
  if (s.slice(i - 1, i) === "\r") return s.slice(0, i - 1); // "...\r\n..."
  return s.slice(0, i); // "...\n..."
}

function stringRemoveFirstLine(s: string): string {
  const i = s.indexOf("\n");
  if (i === -1) return "";
  return s.slice(i + 1);
}

// --------------------------------------------------------------------------------
// Logger

enum _Level {
  Silent,
  Error,
  Warn,
  Info,
  Debug,
}

export class Logger {
  static readonly Level = _Level;

  public level: _Level;
  public color: boolean;

  constructor() {
    this.level = Logger.Level.Warn;
    this.color = tty.isatty(process.stderr.fd);
  }

  // 2006-01-02 15:04:05 [E][func:42] msg
  // 2006-01-02 15:04:05 [E][???:-1] msg
  private _log(level: _Level, ...params: Parameters<typeof util.format>): void {
    if (this.level < level) return;

    const levelChar =
      new Map([
        [Logger.Level.Error, "E"],
        [Logger.Level.Warn, "W"],
        [Logger.Level.Info, "I"],
        [Logger.Level.Debug, "D"],
      ]).get(level) || "[?]";

    const funcLine = (() => {
      const stack = StackTrace.getSync();
      if (stack.length < 3) return `???:-1`;
      stack[3].functionName;
      if (stack[3].functionName === undefined) return `(main):${stack[3].lineNumber}`;
      return `${stack[3].functionName}:${stack[3].lineNumber}`;
    })();

    let txt = `${dateString(new Date())} [${levelChar}][${funcLine}]`;

    if (this.color) {
      const colorEscape =
        new Map([
          [Logger.Level.Error, "\x1b[31m"],
          [Logger.Level.Warn, "\x1b[33m"],
          [Logger.Level.Info, "\x1b[34m"],
          [Logger.Level.Debug, "\x1b[37m"],
        ]).get(level) || "";
      txt = `${colorEscape}${txt} ${util.formatWithOptions({ colors: true }, ...params)}\x1b[0m`;
    } else {
      txt = `${txt} ${util.format(...params)}`;
    }
    process.stderr.write(txt + "\n");
  }

  error(...params: Parameters<typeof util.format>): void {
    this._log(Logger.Level.Error, ...params);
  }

  warn(...params: Parameters<typeof util.format>): void {
    this._log(Logger.Level.Warn, ...params);
  }

  info(...params: Parameters<typeof util.format>): void {
    this._log(Logger.Level.Info, ...params);
  }

  debug(...params: Parameters<typeof util.format>): void {
    this._log(Logger.Level.Debug, ...params);
  }

  // error() with stack trace
  errors(...params: Parameters<typeof util.format>): void {
    const stackStack = stackTraceStack(new Error().stack);
    if (stackStack === null) return;
    this._log(Logger.Level.Error, ...params, "\n", stringRemoveFirstLine(stackStack));
  }
}
