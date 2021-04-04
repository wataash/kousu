// SPDX-License-Identifier: Apache-2.0

/* eslint-disable no-warning-comments */

import * as fs from "fs";

import * as oclifCommand from "@oclif/command";
import * as oclifErrors from "@oclif/errors";
import type * as oclifParser from "@oclif/parser";
import type * as log4js from "log4js";
import * as puppeteer from "puppeteer";

import * as types from "./common";
import { KousuError } from "./common";
import type { ElementHandle } from "puppeteer";

// @template:logger
process.env.LOG_PRETTY = "1";
const loggerLib = require("./logger");
interface LoggerStacktrace {
  errors(message: any, ...args: any[]): void;
  warns(message: any, ...args: any[]): void;
  infos(message: any, ...args: any[]): void;
  debugs(message: any, ...args: any[]): void;
}
export const logger: log4js.Logger & LoggerStacktrace = loggerLib.logger;

// -------------------------------------------------------------------------------------------------
// date

/**
 * @returns {string} '2006-01-01'
 */
export function prevMonthFirst(): string {
  const now = new Date();
  // ok even for January
  // new Date(2006, 0, 2)  -> 2006-01-02
  // new Date(2006, -1, 2) -> 2005-12-02
  const d = new Date(
    now.getFullYear(),
    now.getMonth() - 1,
    1,
    0,
    -now.getTimezoneOffset()
  );
  return d.toISOString().slice(0, 10);
}

/**
 * @returns {string} '2006-01-31'
 */
export function prevMonthLast(): string {
  const now = new Date();
  const d = new Date(
    now.getFullYear(),
    now.getMonth(),
    0,
    0,
    -now.getTimezoneOffset()
  );
  return d.toISOString().slice(0, 10);
}

/**
 * @returns {string} '2006-01'
 */
export function prevMonth(): string {
  return prevMonthFirst().slice(0, 7);
}

// -------------------------------------------------------------------------------------------------
// oclif

export const oclifFlags = {
  help: oclifCommand.flags.help({ char: "h" }),

  "ignore-https": oclifCommand.flags.boolean({
    // IFlagBase
    description: "HTTPSエラーを無視する",
    // IBooleanFlag
    // allowNo: false,
  }),
  "ma-url": oclifCommand.flags.string({
    description:
      "MA-EYESログイン画面のURL (environment variable: KOUSU_MA_URL)",
    required: true,
    env: "KOUSU_MA_URL",
  }),
  "ma-user": oclifCommand.flags.string({
    description: "MA-EYESのユーザー名 (environment variable: KOUSU_MA_USER)",
    required: true,
    env: "KOUSU_MA_USER",
  }),
  "ma-pass": oclifCommand.flags.string({
    description: "MA-EYESのパスワード (environment variable: KOUSU_MA_PASS)",
    required: true,
    env: "KOUSU_MA_PASS",
  }),
  month: oclifCommand.flags.string({
    // IFlagBase
    description:
      "処理する月 (e.g. 2006-01) (environment variable: KOUSU_MONTH)",
    env: "KOUSU_MONTH",
    parse: (input, context) => {
      const match = input.match(/^(\d{4})-(\d{2})$/);
      if (match === null) {
        throw new KousuError(`KOUSU_MONTH must be yyyy-mm (given: ${input})`);
      }
      // XXX: want return [year, month]
      context.year = parseInt(match[1], 10);
      context.month = parseInt(match[2], 10);
      if (isNaN(context.year)) {
        throw new KousuError(
          `KOUSU_MONTH must be yyyy-mm (given: ${input}; invalid year)`
        );
      }
      if (isNaN(context.month)) {
        throw new KousuError(
          `KOUSU_MONTH must be yyyy-mm (given: ${input}; invalid month)`
        );
      }
      return input;
    },
    // IOptionFlag
    // [XXX default]: default will not be parse()ed
    default: prevMonth(), // XXX: should be lazily evaluated
  }),
};

// -------------------------------------------------------------------------------------------------
// puppeteer

export const oclifFlagsPuppeteer = {
  // dev options (hidden)
  "puppeteer-connect-url": oclifCommand.flags.string({
    hidden: true,
    exclusive: ["puppeteer-handle-sigint", "puppeteer-headless"],
  }),
  "puppeteer-cookie-save": oclifCommand.flags.string({
    hidden: true,
    exclusive: ["puppeteer-cookie-load"],
  }),
  "puppeteer-cookie-load": oclifCommand.flags.string({
    hidden: true,
    exclusive: ["puppeteer-cookie-save"],
  }),
  "puppeteer-handle-sigint": oclifCommand.flags.boolean({
    hidden: true,
    exclusive: ["puppeteer-connect-url"],
    allowNo: true,
    default: true,
  }),
  "puppeteer-headless": oclifCommand.flags.boolean({
    hidden: true,
    exclusive: ["puppeteer-connect-url"],
    default: false,
  }),
};

// not sure oclifParser.OutputFlags is correct -- but seems to work
//
// [XXX:eslint-tuple]
export async function puppeteerBrowserPage(
  flgs: oclifParser.OutputFlags<typeof oclifFlags & typeof oclifFlagsPuppeteer>
): Promise<any> /* Promise<[puppeteer.Browser, puppeteer.Page]> */ {
  logger.debug("open chromium");

  const browser = await (async () => {
    if (flgs["puppeteer-connect-url"] !== undefined) {
      return puppeteer.connect({
        // ConnectOptions
        browserURL: "http://localhost:55592",
        // BrowserOptions
        ignoreHTTPSErrors: flgs["ignore-https"],
        // これが無いと800x600になる
        // https://github.com/puppeteer/puppeteer/blob/main/docs/api.md#puppeteerconnectoptions
        defaultViewport: null,
        // slowMo: 50, // for page.type
      });
    }
    return puppeteer.launch({
      // LaunchOptions
      handleSIGINT: flgs["puppeteer-handle-sigint"],
      // ChromeArgOptions
      headless: flgs["puppeteer-headless"],
      // https://peter.sh/experiments/chromium-command-line-switches/
      // args: ["--window-position=20,20", "--window-size=1400,800"],
      // devtools: true,
      // BrowserOptions
      ignoreHTTPSErrors: flgs["ignore-https"],
      defaultViewport: null,
      // slowMo: 50, // for page.type
      // Timeoutable
    });
  })();

  const page = await browser.newPage();
  page.setDefaultTimeout(120_000); // default 30000ms is sometimes too short

  page.on("console", (msg) => {
    logger.debug("log from Puppeteer (Chromium browser):", msg.text());
  });

  return [browser, page];
}

// @template:cookie
// web_cookie.md
export async function puppeteerCookieLoad(
  page: puppeteer.Page,
  cookiePath: string
): Promise<void> {
  if (!fs.existsSync(cookiePath)) {
    // TODO: catch ENOENT instead
    throw new KousuError(`cookie file (${cookiePath}) not found`);
  }
  const txt = fs.readFileSync(cookiePath).toString();
  const cookies: puppeteer.SetCookie[] = JSON.parse(txt);
  for (const cookie of cookies) {
    logger.debug(`page.setCookie(): ${JSON.stringify(cookie)}`);
    // eslint-disable-next-line no-await-in-loop
    await page.setCookie(cookie);
  }
}

export async function puppeteerCookieSave(
  page: puppeteer.Page,
  cookiePath: string
): Promise<void> {
  logger.info("page.cookies()");
  const cookiesObject = await page.cookies();
  const s = JSON.stringify(cookiesObject, null, 2) + "\n";
  logger.info(`writeFile ${cookiePath}`);
  fs.writeFileSync(cookiePath, s);
}

export async function $x(
  page: puppeteer.Page | puppeteer.ElementHandle<Element>,
  expression: string
): Promise<puppeteer.ElementHandle[]> {
  // logger.debug(`$x(\`${expression}\`)`);
  return page.$x(expression);
}

export async function $xn(
  page: puppeteer.Page | puppeteer.ElementHandle<Element>,
  expression: string,
  n: number,
  errMsg: string
): Promise<puppeteer.ElementHandle[]> {
  const elementHandles = await $x(page, expression);
  if (elementHandles.length === n) {
    return elementHandles;
  }
  if (errMsg === "") {
    throw new KousuError(
      `BUG: '$x(\`${expression}\`').length is not ${n}, actually ${elementHandles.length}`
    );
  } else {
    throw new KousuError(
      `BUG: ${errMsg}; $x(\`${expression}'\`.length is not ${n}, actually ${elementHandles.length}`
    );
  }
}

export async function $x1(
  page: puppeteer.Page | puppeteer.ElementHandle<Element>,
  expression: string,
  errMsg: string
): Promise<puppeteer.ElementHandle> {
  return (await $xn(page, expression, 1, errMsg))[0];
}

// -------------------------------------------------------------------------------------------------
// misc

// https://github.com/jonschlinkert/isobject/blob/master/index.js
export function isObject(value) {
  return value !== null && typeof value === "object" && Array.isArray(value) === false;
}

// @template:sleep
export function sleep(milliSeconds: number): Promise<string> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(`slept ${milliSeconds} ms`);
    }, milliSeconds);
  });
}

export async function sleepForever(): Promise<never> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // wakeup every 1 second for debugger to be able to break
    // eslint-disable-next-line no-await-in-loop
    await sleep(1000);
  }
}

export async function run(run2: () => Promise<never>): Promise<never> {
  types.setErrorLogCallback((s: string) => logger.error(s));
  types.setErrorLogStackCallback((s: string) => logger.errors(s));

  await (async () => {
    try {
      await run2();
    } catch (error) {
      if (
        !(
          error.constructor.name === "ExitError" ||
          error.constructor.name === "KousuError" ||
          error.constructor.name === "RequiredFlagError"
        )
      ) {
        logger.warn(`error.constructor.name: ${error.constructor.name}`);
      }
      if (
        !(error instanceof KousuError || error instanceof oclifErrors.CLIError)
      ) {
        logger.error(
          `unexpected error: ${error.message}\nstack trace:\n${error.stack}`
        );
      }
      throw error;
    }
  })();

  // suppress: TS2534: A function returning 'never' cannot have a reachable end point.
  throw new KousuError("BUG: NOTREACHED", true);
}
