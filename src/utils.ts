// SPDX-License-Identifier: Apache-2.0

/* eslint-disable no-warning-comments */

import * as fs from "node:fs";
import * as inspector from "node:inspector";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type * as log4js from "log4js";
import * as puppeteer from "puppeteer";

import * as types from "./common";
import { KousuError } from "./common";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, -now.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

/**
 * @returns {string} '2006-01-31'
 */
export function prevMonthLast(): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), 0, 0, -now.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

/**
 * @returns {string} '2006-01'
 */
export function prevMonth(): string {
  return prevMonthFirst().slice(0, 7);
}

// -------------------------------------------------------------------------------------------------
// puppeteer

export async function puppeteerBrowserPage(
  ignoreHTTPSErrors: boolean,
  puppeteerConnectUrl: string | null,
  puppeteerLaunchHandleSIGINT: boolean,
  puppeteerLaunchHeadless: boolean
): Promise<[puppeteer.Browser, puppeteer.Page]> {
  logger.debug("open chromium");

  const browser = await (async () => {
    if (puppeteerConnectUrl !== null) {
      return puppeteer.connect({
        // ConnectOptions
        browserURL: puppeteerConnectUrl,
        // BrowserOptions
        ignoreHTTPSErrors,
        // これが無いと800x600になる
        // https://github.com/puppeteer/puppeteer/blob/main/docs/api.md#puppeteerconnectoptions
        defaultViewport: null,
        // slowMo: 50, // for page.type
      });
    }
    return puppeteer.launch({
      // LaunchOptions
      handleSIGINT: puppeteerLaunchHandleSIGINT,
      // ChromeArgOptions
      headless: puppeteerLaunchHeadless,
      // https://peter.sh/experiments/chromium-command-line-switches/
      // args: ["--window-position=20,20", "--window-size=1400,800"],
      // devtools: true,
      // BrowserOptions
      ignoreHTTPSErrors,
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

export async function puppeteerClose(browser: puppeteer.Browser, disconnect: boolean): Promise<void> {
  if (disconnect) {
    browser.disconnect();
  } else {
    browser.close();
  }
}

// @template:cookie
// web_cookie.md
export async function puppeteerCookieLoad(page: puppeteer.Page, cookiePath: string): Promise<void> {
  if (!fs.existsSync(cookiePath)) {
    // TODO: catch ENOENT instead
    throw new KousuError(`cookie file (${cookiePath}) not found`);
  }
  const txt = fs.readFileSync(cookiePath, "utf8");
  const cookies: puppeteer.Protocol.Network.CookieParam[] = JSON.parse(txt);
  for (const cookie of cookies) {
    logger.debug(`page.setCookie(): ${JSON.stringify(cookie)}`);
    // eslint-disable-next-line no-await-in-loop
    await page.setCookie(cookie);
  }
}

export async function puppeteerCookieSave(page: puppeteer.Page, cookiePath: string): Promise<void> {
  logger.info("page.cookies()");
  const cookiesObject = await page.cookies();
  const s = JSON.stringify(cookiesObject, null, 2) + "\n";
  logger.info(`writeFile ${cookiePath}`);
  fs.writeFileSync(cookiePath, s);
}

export async function $x(
  page: puppeteer.Page | puppeteer.ElementHandle<Element>,
  expression: string
): ReturnType<typeof page.$x> {
  // logger.debug(`$x(\`${expression}\`)`);
  return page.$x(expression);
}

export async function $xn(
  page: puppeteer.Page | puppeteer.ElementHandle<Element>,
  expression: string,
  n: number,
  errMsg: string
): ReturnType<typeof $x> {
  const elementHandles = await $x(page, expression);
  if (elementHandles.length === n) {
    return elementHandles;
  }
  if (errMsg === "") {
    throw new KousuError(`BUG: '$x(\`${expression}\`').length is not ${n}, actually ${elementHandles.length}`);
  } else {
    throw new KousuError(`BUG: ${errMsg}; $x(\`${expression}'\`.length is not ${n}, actually ${elementHandles.length}`);
  }
}

export async function $x1(
  page: puppeteer.Page | puppeteer.ElementHandle<Element>,
  expression: string,
  errMsg: string
): Promise<puppeteer.ElementHandle<Node>> {
  return (await $xn(page, expression, 1, errMsg))[0];
}

// -------------------------------------------------------------------------------------------------
// misc

// https://github.com/jonschlinkert/isobject/blob/master/index.js
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function isObject(value: any): boolean {
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

export function waitDebuggerAttach() {
  // if (!process.execArgv.includes("--inspect")) {
  if (inspector.url() === undefined) {
    // not in debugger
    return;
  }

  const start = Date.now();
  for (;;) {
    // TODO: detect connected
    // child_process.execSync(`lsof -nP -p ${process.pid}`, {stdio: "inherit", encoding: "utf8"});

    const delta = Date.now() - start;
    // delta: breaks at around 0-1000; so >2000 is enough
    // webstorm: break this:
    // - [ ] Suspend execution
    // - [x] Evaluate and log: delta = 9999
    if (delta > 2000) {
      break;
    }
  }
}
