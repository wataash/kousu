#!/usr/bin/env node

// SPDX-License-Identifier: Apache-2.0

import * as assert from "node:assert";
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";

// @ts-ignore
import * as awaitNotify from "await-notify";
import * as commander from "commander";
import { program } from "commander";

import { run as commandGet } from "./command-get";
import { run as commandImportKinmu } from "./command-import-kinmu";
import { run as commandPut } from "./command-put";
import * as common from "./common";
import { KousuError } from "./common";
import * as utils from "./utils";
import { logger } from "./utils";

utils.waitDebuggerAttach();

const initialize = new awaitNotify.Subject();

// -----------------------------------------------------------------------------
// cli

const ARGV = process.argv.slice(2);
const VERSION = "1.0.0";

function increaseVerbosity(value: string /* actually undefined */, previous: number): number {
  return previous + 1;
}

function parseMonth(value: string, previous: unknown): [number, number] {
  const match = value.match(/^(\d{4})-(\d{2})$/);
  if (match === null) {
    throw new commander.InvalidArgumentError(`KOUSU_MONTH must be yyyy-mm (given: ${value})`);
  }
  // XXX: want return [year, month]
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  if (isNaN(year)) {
    throw new commander.InvalidArgumentError(`KOUSU_MONTH must be yyyy-mm (given: ${value}; invalid year)`);
  }
  if (isNaN(month)) {
    throw new commander.InvalidArgumentError(`KOUSU_MONTH must be yyyy-mm (given: ${value}; invalid month)`);
  }
  return [year, month];
}

export interface Args {
  ignoreHttps: boolean;
  maPass: string;
  maUrl: string;
  maUser: string;
  month: [number, number];
  quiet: boolean;
  verbose: number;
  zPuppeteerConnectUrl?: string;
  zPuppeteerCookieLoad?: string;
  zPuppeteerCookieSave?: string;
  zPuppeteerLaunchHandleSigint: boolean;
  zPuppeteerLaunchHeadless: boolean;
}

// prettier-ignore
program
  .name("kousu")
  .description("ビーブレイクシステムズMA-EYES（webアプリ版）の作業実績（工数）入力を行う")
  .version(VERSION)
  .addOption(new commander.Option("--ignore-https", "HTTPSエラーを無視する").default(false))
  .addOption(new commander.Option("--ma-pass <pass>", "MA-EYESのパスワード").env("KOUSU_MA_PASS").makeOptionMandatory(true))
  .addOption(new commander.Option("--ma-url <url>", "MA-EYESログイン画面のURL").env("KOUSU_MA_URL").makeOptionMandatory(true))
  .addOption(new commander.Option("--ma-user <user>", "MA-EYESのユーザー名").env("KOUSU_MA_USER").makeOptionMandatory(true))
  .addOption(new commander.Option("--month <yyyy-mm>", "処理する月 (e.g. 2006-01)").env("KOUSU_MONTH").makeOptionMandatory(true).default(parseMonth(utils.prevMonth(), null), utils.prevMonth()).argParser(parseMonth))
  .addOption(new commander.Option("-q, --quiet", "quiet mode").default(false))
  .addOption(new commander.Option("-v, --verbose", "print verbose output; -vv to print debug output").default(0).argParser(increaseVerbosity))
  .addOption(new commander.Option("    --z-puppeteer-connect-url <url>").hideHelp(false).conflicts(["zPuppeteerLaunchHandleSigint", "zPuppeteerLaunchHeadless"]))
  .addOption(new commander.Option("    --z-puppeteer-cookie-load <path>").hideHelp(false).conflicts(["zPuppeteerCookieSave"]))
  .addOption(new commander.Option("    --z-puppeteer-cookie-save <path>").hideHelp(false).conflicts(["zPuppeteerCookieLoad"]))
  .addOption(new commander.Option(" --no-z-puppeteer-launch-handle-sigint").hideHelp(false).conflicts(["zPuppeteerConnectUrl"]))
  .addOption(new commander.Option("    --z-puppeteer-launch-headless").hideHelp(false).default(false).conflicts(["zPuppeteerConnectUrl"]))
  .alias(); // dummy

function errorOutCsv(value: string /* actually undefined */, previous: undefined): never {
  throw new commander.InvalidArgumentError(
    "--out-csv (KOUSU_OUT_CSV) は 0.2.0 で削除され、--out-json のみサポートになりました"
  );
}

function errorOutJson(value: string /* actually undefined */, previous: undefined): never {
  throw new commander.InvalidArgumentError(
    "--out-json (KOUSU_OUT_JSON) は 0.3.0 で削除され、非オプション引数になりました"
  );
}

export interface ArgsGet {
  file: string;
}

// prettier-ignore
program
  .command("get")
  .description("MA-EYESにログインして工数実績を取得する")
  .addOption(new commander.Option("--out-csv <path>").env("KOUSU_OUT_CSV").hideHelp(true).argParser(errorOutCsv))
  .addOption(new commander.Option("--out-json <path>").env("KOUSU_OUT_JSON").hideHelp(true).argParser(errorOutJson))
  .argument("<file>", "JSONの出力パス")
  .allowExcessArguments(false)
  .action(async (file: string, options: ArgsGet) => {
    await initialize.wait(0);
    try {
      const exitCode = await commandGet(program.opts(), { ...options, file });
      process.exit(exitCode);
    } catch (e) {
      if (!(e instanceof Error)) {
        logger.errors("NOTREACHED");
        throw e;
      }
      if (e.constructor.name === "KousuError") {
        // assert(e instanceof KousuError)
        process.exit(1);
      }
      logger.warn(`e.constructor.name: ${e.constructor.name}`);
      logger.error(`unexpected error: ${e.message}\nstack trace:\n${e.stack}`);
      throw e;
    }
    "breakpoint".match(/breakpoint/);
  });

export interface ArgsImportKinmu {}

// prettier-ignore
program
  .command("import-kinmu")
  .description("MA-EYESにログインして「勤務時間取込」「保存」を行う")
  .allowExcessArguments(false)
  .action(async (options: ArgsImportKinmu) => {
    await initialize.wait(0);
    try {
      const exitCode = await commandImportKinmu(program.opts(), { ...options });
      process.exit(exitCode);
    } catch (e) {
      if (!(e instanceof Error)) {
        logger.errors("NOTREACHED");
        throw e;
      }
      if (e.constructor.name === "KousuError") {
        // assert(e instanceof KousuError)
        process.exit(1);
      }
      logger.warn(`e.constructor.name: ${e.constructor.name}`);
      logger.error(`unexpected error: ${e.message}\nstack trace:\n${e.stack}`);
      throw e;
    }
    "breakpoint".match(/breakpoint/);
  });

function errorInCsv(value: string /* actually undefined */, previous: undefined): never {
  throw new commander.InvalidArgumentError(
    "--in-csv (KOUSU_IN_CSV) は 0.2.0 で削除され、--in-json のみサポートになりました"
  );
}

function errorInJson(value: string /* actually undefined */, previous: undefined): never {
  throw new commander.InvalidArgumentError(
    "--in-json (KOUSU_IN_JSON) は 0.3.0 で削除され、非オプション引数になりました"
  );
}

export interface ArgsPut {
  file: string;
}

// prettier-ignore
program
  .command("put")
  .description("MA-EYESにログインして工数実績を入力する")
  .addOption(new commander.Option("--in-csv <path>").env("KOUSU_IN_CSV").hideHelp(true).argParser(errorInCsv))
  .addOption(new commander.Option("--in-json <path>").env("KOUSU_IN_JSON").hideHelp(true).argParser(errorInJson))
  .argument("<file>", "入力するJSONのパス")
  .allowExcessArguments(false)
  .action(async (file: string, options: ArgsPut) => {
    await initialize.wait(0);
    try {
      const exitCode = await commandPut(program.opts(), { ...options, file });
      process.exit(exitCode);
    } catch (e) {
      if (!(e instanceof Error)) {
        logger.errors("NOTREACHED");
        throw e;
      }
      if (e.constructor.name === "KousuError") {
        // assert(e instanceof KousuError)
        process.exit(1);
      }
      logger.warn(`e.constructor.name: ${e.constructor.name}`);
      logger.error(`unexpected error: ${e.message}\nstack trace:\n${e.stack}`);
      throw e;
    }
    "breakpoint".match(/breakpoint/);
  });

program.parse(process.argv);

if (program.opts().quiet === true && program.opts().verbose > 0) {
  process.stderr.write("error: -q and -v are mutually exclusive\n");
  process.exit(1);
}

if (program.opts().quiet === true) {
  logger.level = "error";
} else if (program.opts().verbose === 0) {
  logger.level = "warn";
} else if (program.opts().verbose === 1) {
  logger.level = "info";
} else if (program.opts().verbose >= 1) {
  logger.level = "debug";
}

logger.debug(`${path.basename(__filename)} version ${VERSION}`);

logger.debug(program.args);

// -----------------------------------------------------------------------------
// main

common.setErrorLogCallback((s: string) => logger.error(s));
common.setErrorLogStackCallback((s: string) => logger.errors(s));

initialize.notify();
