// SPDX-License-Identifier: Apache-2.0

import * as path from "node:path";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import * as awaitNotify from "await-notify";
import * as commander from "commander";
import { program } from "commander";

import { run as commandGet } from "./command-get";
import { run as commandImportKinmu } from "./command-import-kinmu";
import { run as commandPut } from "./command-put";
import * as common from "./common";
import { AppError } from "./common";
import * as utils from "./utils";
import { logger } from "./utils";

const initialize = new awaitNotify.Subject();

// TODO: implement as queue
const exit = new awaitNotify.Subject();
let exitCode = -1;

// -----------------------------------------------------------------------------
// cli

export const VERSION = "2.0.4";

/* eslint-disable @typescript-eslint/no-unused-vars */
function increaseVerbosity(value: string /* actually undefined */, previous: number): number {
  return previous + 1;
}

/* eslint-disable @typescript-eslint/no-unused-vars */
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
  // program.opts()
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
  // program.args
}

// prettier-ignore
program
  .name("kousu")
  .description("ビーブレイクシステムズMA-EYES（webアプリ版）の作業実績（工数）入力を行う")
  .version(VERSION)
  .addOption(new commander.Option("    --ignore-https", "HTTPSエラーを無視する").default(false))
  .addOption(new commander.Option("    --ma-pass <pass>", "MA-EYESのパスワード").env("KOUSU_MA_PASS").makeOptionMandatory(true))
  .addOption(new commander.Option("    --ma-url <url>", "MA-EYESログイン画面のURL").env("KOUSU_MA_URL").makeOptionMandatory(true))
  .addOption(new commander.Option("    --ma-user <user>", "MA-EYESのユーザー名").env("KOUSU_MA_USER").makeOptionMandatory(true))
  .addOption(new commander.Option("    --month <yyyy-mm>", "処理する月 (e.g. 2006-01)").env("KOUSU_MONTH").makeOptionMandatory(true).default(parseMonth(utils.prevMonth(), null), utils.prevMonth()).argParser(parseMonth))
  .addOption(new commander.Option("-q, --quiet", "quiet mode").default(false).conflicts("verbose"))
  .addOption(new commander.Option("-v, --verbose", "print verbose output; -vv to print debug output").default(0).argParser(increaseVerbosity).conflicts("quiet"))
  .addOption(new commander.Option("    --z-puppeteer-connect-url <url>").hideHelp().conflicts(["zPuppeteerLaunchHandleSigint", "zPuppeteerLaunchHeadless"]))
  .addOption(new commander.Option("    --z-puppeteer-cookie-load <path>").hideHelp().conflicts(["zPuppeteerCookieSave"]))
  .addOption(new commander.Option("    --z-puppeteer-cookie-save <path>").hideHelp().conflicts(["zPuppeteerCookieLoad"]))
  .addOption(new commander.Option(" --no-z-puppeteer-launch-handle-sigint").hideHelp().conflicts(["zPuppeteerConnectUrl"]))
  .addOption(new commander.Option("    --z-puppeteer-launch-headless").hideHelp().default(false).conflicts(["zPuppeteerConnectUrl"]))
  .alias(); // dummy

/* eslint-disable @typescript-eslint/no-empty-interface */
export interface ArgsImportKinmu {
  // program.opts()
  // program.args
}

// prettier-ignore
program
  .command("import-kinmu")
  .description("MA-EYESにログインして「勤務時間取込」「保存」を行う")
  .allowExcessArguments(false)
  .action(async (options: ArgsImportKinmu) => {
    await initialize.wait(0);
    try {
      exitCode = await commandImportKinmu(program.opts(), { ...options });
      exit.notify();
      return;
    } catch (e) {
      if (!(e instanceof Error)) {
        logger.errors("NOTREACHED");
        throw e;
      }
      if (e instanceof AppError) {
        // assert.ok(e.constructor.name === "AppError")
        process.exit(1);
      }
      logger.error(`unexpected error: ${e}`);
      throw e;
    }
    throw new AppError("NOTREACHED", true);
  });

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

/* eslint-disable @typescript-eslint/no-unused-vars */
function errorInCsv(value: string /* actually undefined */, previous: undefined): never {
  throw new commander.InvalidArgumentError(
    "--in-csv (KOUSU_IN_CSV) は 0.2.0 で削除され、--in-json のみサポートになりました"
  );
}

/* eslint-disable @typescript-eslint/no-unused-vars */
function errorInJson(value: string /* actually undefined */, previous: undefined): never {
  throw new commander.InvalidArgumentError(
    "--in-json (KOUSU_IN_JSON) は 0.3.0 で削除され、非オプション引数になりました"
  );
}

export interface ArgsGet {
  // program.opts()
  // program.args
  file: string;
}

// prettier-ignore
program
  .command("get")
  .description("MA-EYESにログインして工数実績を取得する")
  .allowExcessArguments(false)
  .addOption(new commander.Option("    --out-csv <path>").env("KOUSU_OUT_CSV").hideHelp().argParser(errorOutCsv))
  .addOption(new commander.Option("    --out-json <path>").env("KOUSU_OUT_JSON").hideHelp().argParser(errorOutJson))
  .argument("<file>", "JSONの出力パス")
  .action(async (file: string, options: ArgsGet) => {
    await initialize.wait(0);
    try {
      exitCode = await commandGet(program.opts(), { ...options, file });
      exit.notify();
      return;
    } catch (e) {
      if (!(e instanceof Error)) {
        logger.errors("NOTREACHED");
        throw e;
      }
      if (e instanceof AppError) {
        // assert.ok(e.constructor.name === "AppError")
        process.exit(1);
      }
      logger.error(`unexpected error: ${e}`);
      throw e;
    }
    throw new AppError("NOTREACHED", true);
  });

export interface ArgsPut {
  // program.opts()
  // program.args
  file: string;
}

// prettier-ignore
program
  .command("put")
  .description("MA-EYESにログインして工数実績を入力する")
  .allowExcessArguments(false)
  .addOption(new commander.Option("    --in-csv <path>").env("KOUSU_IN_CSV").hideHelp().argParser(errorInCsv))
  .addOption(new commander.Option("    --in-json <path>").env("KOUSU_IN_JSON").hideHelp().argParser(errorInJson))
  .argument("<file>", "入力するJSONのパス")
  .action(async (file: string, options: ArgsPut) => {
    await initialize.wait(0);
    try {
      exitCode = await commandPut(program.opts(), { ...options, file });
      exit.notify();
      return;
    } catch (e) {
      if (!(e instanceof Error)) {
        logger.errors("NOTREACHED");
        throw e;
      }
      if (e instanceof AppError) {
        // assert.ok(e.constructor.name === "AppError")
        process.exit(1);
      }
      logger.error(`unexpected error: ${e}`);
      throw e;
    }
    throw new AppError("NOTREACHED", true);
  });

export async function run(): Promise<never> {
  program.parse(process.argv);

  if (program.opts().quiet === true) {
    logger.level = Logger.Level.Error;
  } else if (program.opts().verbose === 0) {
    logger.level = Logger.Level.Warn;
  } else if (program.opts().verbose === 1) {
    logger.level = Logger.Level.Info;
  } else if (program.opts().verbose >= 1) {
    logger.level = Logger.Level.Debug;
  }

  logger.debug(`${path.basename(__filename)} version ${VERSION}`);

  logger.debug("args: %O", process.argv);

  common.setErrorLogCallback((s: string) => logger.error(s));
  common.setErrorLogStackCallback((s: string) => logger.errors(s));

  initialize.notify();
  await exit.wait(0);
  process.exit(exitCode);
}
