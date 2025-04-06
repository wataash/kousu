// SPDX-FileCopyrightText: Copyright (c) 2021-2025 Wataru Ashihara <wataash0607@gmail.com>
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @typescript-eslint/no-empty-object-type */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable no-constant-condition */
/* eslint-disable no-debugger */

import assert from "assert"; // in babel: replaced with: import assert from "power-assert";
// not replaced:
// import * as assert from "assert/strict";
// import * as assert from "node:assert";
// import * as assert from "node:assert/strict";
// import assert from "assert/strict";
// import assert from "node:assert";
// import assert from "node:assert/strict";

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as url from "node:url";
import * as path from "node:path";
import * as v8 from "node:v8";

import * as commander from "@commander-js/extra-typings";
import * as puppeteer from "puppeteer";
import { Browser, ElementHandle, JSHandle, Locator, NodeFor, Page } from "puppeteer";

import { Logger } from "./logger.js";

const __filename = url.fileURLToPath(import.meta.url);
const logger = new Logger();
const program = new commander.Command();
export const VERSION = "3.0.1";

class AppError extends Error {}

class AppErrorStack extends Error {}

// -----------------------------------------------------------------------------
// cli

export async function cliMain(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
    process.exitCode = await cliCommandExitPromise;
    assert.ok(process.exitCode !== undefined);
    return;
  } catch (e) {
    if (e instanceof AppError) {
      logger.error(e.message);
      process.exitCode = 1;
      return;
    }
    if (e instanceof AppErrorStack) {
      logger.error(e.message);
      logger.info(e);
      // throw e;
      process.exitCode = 1;
      return;
    }
    if (!(e instanceof Error)) throw e;
    logger.error(`unexpected error: ${e}`);
    logger.error(`unexpected error: ${e.message}`);
    throw e;
  }
  unreachable();
}

class CLI {
  static invalidArgument(errMsg: string): never {
    throw new commander.InvalidArgumentError(errMsg);
  }

  static parseMonth(value: string, previous: unknown): [number, number] {
    const match = value.match(/^(\d{4})-(\d{2})$/);
    if (match === null) {
      throw new commander.InvalidArgumentError(`KOUSU_MONTH must be yyyy-mm (given: ${value})`);
    }
    return [parseInt(match[1], 10), parseInt(match[2], 10)];
  }
}

// @ts-expect-error initially {}, but assigned later
const cliOptsGlobal: {
  ignoreHttps: boolean;
  maPass: string;
  maUrl: string;
  maUser: string;
  month: [number, number];
  quiet: number;
  zPptrLaunchArgs: string[];
  zPptrConnectUrl?: string;
  zPptrCookieLoad?: string;
  zPptrCookieSave?: string;
  zPptrLaunchDevTools: boolean;
  zPptrLaunchHandleSigint: boolean;
  zPptrLaunchHeadless: boolean;
} = {};

let commandNoRun = false;

// prettier-ignore
program
  .name("kousu")
  .description("ビーブレイクシステムズMA-EYES（webアプリ版）の作業実績（工数）入力を行う")
  .version(VERSION)
  .addOption(new commander.Option("--ignore-https", "HTTPSエラーを無視する").default(false))
  .addOption(new commander.Option("--ma-pass <pass>", "MA-EYESのパスワード").env("KOUSU_MA_PASS").makeOptionMandatory(true))
  .addOption(new commander.Option("--ma-url <url>", "MA-EYESログイン画面のURL").env("KOUSU_MA_URL").makeOptionMandatory(true))
  .addOption(new commander.Option("--ma-user <user>", "MA-EYESのユーザー名").env("KOUSU_MA_USER").makeOptionMandatory(true))
  .addOption(new commander.Option("--month <yyyy-mm>", "処理する月 (e.g. 2006-01)").env("KOUSU_MONTH").makeOptionMandatory(true).default(CLI.parseMonth(datePrevMonth(), null), datePrevMonth()).argParser(CLI.parseMonth))
  .addOption(new commander.Option("-q, --quiet", "quiet mode; -q to suppress debug log, -qq to suppress info log, -qqq to suppress warn log, -qqqq to suppress error log").default(0).argParser((_undefined, previous: number) => previous + 1))
  .addOption(new commander.Option("-v, --verbose").argParser(() => logger.warn("-v, --verbose オプションは3.0.0で削除されました")))
  .addOption(new commander.Option("--z-pptr-cookie-load <path>").hideHelp().conflicts(["zPptrCookieSave"]))
  .addOption(new commander.Option("--z-pptr-cookie-save <path>").hideHelp().conflicts(["zPptrCookieLoad"]))
  // puppeteer.ConnectOptions
  .addOption(new commander.Option("--z-pptr-connect-url <url>").hideHelp().conflicts(["zPptrLaunchHandleSigint", "zPptrLaunchHeadless"]))
  // puppeteer.LaunchOptions
  .addOption(new commander.Option("--z-pptr-launch-args <args...>").default([] as string[]).conflicts(["zPptrConnectUrl"])) // --z-pptr-launch-args --window-position=20,20 --z-pptr-launch-args --window-size=1400,800
  .addOption(new commander.Option("--z-pptr-launch-dev-tools").hideHelp().default(false).conflicts(["zPptrConnectUrl"]))
  .addOption(new commander.Option("--no-z-pptr-launch-handle-sigint").hideHelp().conflicts(["zPptrConnectUrl"]))
  .addOption(new commander.Option("--z-pptr-launch-headless").hideHelp().default(false).conflicts(["zPptrConnectUrl"]))
  .hook("preAction", async (thisCommand, actionCommand) => {
    Object.freeze(Object.assign(cliOptsGlobal, thisCommand.opts()));
    // prettier-ignore
    switch (true) {
      case cliOptsGlobal.quiet === 0: logger.level = Logger.Level.Debug; break;
      case cliOptsGlobal.quiet === 1: logger.level = Logger.Level.Info; break;
      case cliOptsGlobal.quiet === 2: logger.level = Logger.Level.Warn; break;
      case cliOptsGlobal.quiet === 3: logger.level = Logger.Level.Error; break;
      case cliOptsGlobal.quiet >= 4: logger.level = Logger.Level.Silent; break;
    }
    logger.debug(`${path.basename(__filename)} version ${VERSION} PID ${process.pid}`, process.argv);

    if ("zPptrCookieSave" in cliOptsGlobal) {
      commandNoRun = true;
      const [browser, page] = await pptrBrowserPage();
      await maEyesLogin(page);
      logger.info("cookie-save done;");
      await pptrEnd(browser);
      logger.debug("bye");
      return cliCommandExit(0);
    }
  });

// const { promise: cliCommandExitPromise, resolve: cliCommandExit }  = Promise.withResolvers<number>();
const { promise: cliCommandExitPromise, resolve: cliCommandExit } = PromiseWithResolvers<number>();

/*
NODE_OPTIONS="--enable-source-maps --import @power-assert/node" KOUSU_TEST=1 kousu
NODE_OPTIONS="--enable-source-maps --import @power-assert/node --inspect-wait" KOUSU_TEST=1 kousu
Some basic tests are done in TODO c.ts CTS_TEST_CLI
*/
if (process.env.KOUSU_TEST) {
  logger.warn("KOUSU_TEST");
  if (process.env.NODE_OPTIONS !== undefined) {
    process.env.NODE_OPTIONS = strNodeOptionsRemoveInspect(process.env.NODE_OPTIONS);
  }
  const { KOUSU_TEST, ...env } = process.env;
  let r; // result of child_process.spawnSync()
  let out, err; // previous stdout, stderr

  // eslint-disable-next-line prefer-const
  r = child_process.spawnSync(`kousu -v`, { encoding: "utf8", env, shell: true, stdio: "pipe" });
  assert.ok(r.signal === null && !("error" in r) && r.status === 1 && r.stdout === "" && r.stderr !== "");
  assert.match(r.stderr, /^\d{4}-\d{2}-\d{2} .+ -v, --verbose オプションは3.0.0で削除されました(\r?\n)Usage: kousu /);
  // eslint-disable-next-line prefer-const
  [out, err] = [r.stdout, r.stderr];
}

// -----------------------------------------------------------------------------
// lib

/**
 * @returns {string} '2006-01-01'
 */
function datePrevMonthFirst(): string {
  const now = new Date();
  // ok even in January
  // new Date(2006, 0, 2)  -> 2006-01-02
  // new Date(2006, -1, 2) -> 2005-12-02
  return new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, -now.getTimezoneOffset()).toISOString().slice(0, 10);
}

/**
 * @returns {string} '2006-01-31'
 */
function datePrevMonthLast(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 0, 0, -now.getTimezoneOffset()).toISOString().slice(0, 10);
}

/**
 * @returns {string} '2006-01'
 */
function datePrevMonth(): string {
  return datePrevMonthFirst().slice(0, 7);
}

let debugREPLResolvers: ReturnType<typeof PromiseWithResolvers> | null = null;

/*
debugger:
debugREPL();
debugger, repl:
await page.$$eval(`::-p-text(ユーザコード)`, async (els) => els.map((el) => { console.log(el); debugger; return el.textContent }));
await page.$eval(`::-p-text(ユーザコード)`, (el) => { console.log(el); debugger; });
*/

// @ts-expect-error using globalThis.page
async function debugREPL(page: Page = globalThis.page): Promise<void> {
  debugREPLResolvers = PromiseWithResolvers();

  logger.warns(`debugREPL: await import("repl")`);
  const repl = await import("repl");
  logger.warns(`debugREPL: await import("repl") done`);

  const origTimeout = page.getDefaultTimeout(); // 30_000 or 120_000
  page.setDefaultTimeout(1000);

  const replServer = repl.start();
  replServer.context.b = page.browser();
  replServer.context.browser = page.browser();
  replServer.context.cliOptsGlobal = cliOptsGlobal;
  replServer.context.debugREPLResolvers = debugREPLResolvers;
  replServer.context.logger = logger;
  replServer.context.p = page;
  replServer.context.page = page;
  replServer.context.page = page;
  replServer.on("exit", () => {
    logger.warns(`debugREPL: replServer.on("exit")`);
    debugREPLResolvers!.resolve(null);
    debugREPLResolvers = null;
    page.setDefaultTimeout(origTimeout);
  });

  // @ts-expect-error debugger (node --inspect) から参照できるように
  globalThis.replServer = replServer;

  logger.warn("debugREPL: await debugREPLResolvers.promise");
  await debugREPLResolvers.promise;
  logger.warn("debugREPL: await debugREPLResolvers.promise done");
}
// @ts-expect-error debuggerでbreak中に rpl()
globalThis.rpl = debugREPL;

async function debugREPLMayWait(): Promise<void> {
  if (debugREPLResolvers === null) {
    return;
  }
  logger.warn("debugREPLMayWait: await debugREPLResolvers.promise");
  await debugREPLResolvers.promise;
  // in debugger: can rpl() again here
  await debugREPLMayWait();
  logger.warns("debugREPLMayWait: await debugREPLResolvers.promise done");
}

// https://github.com/jonschlinkert/isobject/blob/master/index.js
function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object" && Array.isArray(value) === false;
}

function jsonParsePath(path: string): ReturnType<typeof JSON.parse> {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    e.message = `invalid JSON: ${path}: ${e.message}`;
    throw e;
  }
}

async function maEyesLogin(page: Page): Promise<void> {
  if (cliOptsGlobal.zPptrCookieLoad !== undefined) {
    await pptrCookieLoad(page.browser(), cliOptsGlobal.zPptrCookieLoad);
    logger.debug(`page.goto ${cliOptsGlobal.maUrl}`);
    await page.goto(cliOptsGlobal.maUrl);
    await page.locator(`::-p-text(工数実績入力)`).wait();
    return;
  }

  logger.debug(`page.goto ${cliOptsGlobal.maUrl}`);
  await page.goto(cliOptsGlobal.maUrl);

  // .../loginView.xhtml (login)
  // .../workResult.xhtml (already logged in; when using --pptr-connect-url)
  if (page.url().endsWith("/workResult.xhtml")) {
    logger.debug("already logged in");
    return;
  }

  await debugREPLMayWait();
  /*
<tr>
<td><label id="loginView:j_idt21" class="ui-outputlabel ui-widget" for="loginView:userCode:input">ユーザコード<span class="ui-outputlabel-rfi">*</span></label></td>
<td>
		<div class="input-component" id="loginView:userCode"><input id="loginView:userCode:input" name="loginView:userCode:input" type="text" maxlength="2147483647" tabindex="0" onfocus="this.setSelectionRange(0, this.value.length)" aria-required="true" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all ma-input" data-p-label="ユーザコード" data-p-required="true" role="textbox" aria-disabled="false" aria-readonly="false" placeholder=""><div id="loginView:userCode:j_idt27" aria-live="polite" data-display="both" data-target="loginView:userCode:input" data-redisplay="true" class="error-label ui-message"></div>
		</div></td>
</tr>
   */
  await page.locator(`::-p-xpath(//input[@data-p-label="ユーザコード"])`).fill(cliOptsGlobal.maUser);
  await page.locator(`::-p-xpath(//input[@data-p-label="パスワード"])`).fill(cliOptsGlobal.maPass);
  await page.locator(`button ::-p-text(login)`).click();
  await page.locator(`::-p-text(工数実績入力)`).wait();
  if (cliOptsGlobal.zPptrCookieSave !== undefined) {
    await pptrCookieSave(page.browser(), cliOptsGlobal.zPptrCookieSave);
  }
}

async function maEyesWaitLoadingSpinnerGIF(page: Page, kind: "_exist_" | "_not_exist_", timeoutMs: number): Promise<"success" | "error" | "timeout"> {
  if (0) {
    // spinner が出ているところでchromeを止める; needs --z-pptr-launch-dev-tools
    // prettier-ignore
    await page.evaluate(async () => { debugger; await new Promise((r) => setTimeout(r, 100)); debugger; await new Promise((r) => setTimeout(r, 100)); debugger; await new Promise((r) => setTimeout(r, 100)); debugger; });
  }
  // logger.debug(`wait loading spinner-GIF ${kind}...`);
  const waitMs = 100;
  for (let i = 0; i < timeoutMs / waitMs; i++) {
    // <!-- 通常時; loading spinner-GIF: _not_exist_ -->
    // <div id="workResultView:j_idt50:j_idt51" class="ui-blockui-content ui-widget ui-widget-content ui-corner-all ui-helper-hidden ui-shadow"></div>
    // <div id="workResultView:j_idt57"         class="ui-blockui-content ui-widget ui-widget-content ui-corner-all ui-helper-hidden ui-shadow" style="left: 504.795px; top: 410.55px; z-index: 1327; display: none;">
    //   <!--                                                                                                                                                                                         ^^^^^^^^^^^^^^ -->
    //   <img id="workResultView:j_idt58" src="/maeyes/javax.faces.resource/loading.gif.xhtml?ln=image" alt="">
    // </div>
    // <!-- 画面遷移時; loading spinner-GIF: _exist_ -->
    // <div id="workResultView:j_idt50:j_idt51" class="ui-blockui-content ui-widget ui-widget-content ui-corner-all ui-helper-hidden ui-shadow"></div>
    // <div id="workResultView:j_idt57"         class="ui-blockui-content ui-widget ui-widget-content ui-corner-all ui-helper-hidden ui-shadow" style="left: 504.795px; top: 410.55px; z-index: 1256; display: block;">
    //   <!--                                                                                                                                                                                         ^^^^^^^^^^^^^^^ -->
    //   <img id="workResultView:j_idt58" src="/maeyes/javax.faces.resource/loading.gif.xhtml?ln=image" alt="">
    // </div>
    await debugREPLMayWait();
    const blockuiContent = await page.$$(`div.ui-blockui-content`);
    if (blockuiContent.length !== 2) {
      logger.warn(`BUG: number of div.ui-blockui-content: ${blockuiContent.length}; wait 5s and return`);
      await sleep(5000);
      return "error";
    }
    const blockui1Content = await blockuiContent[1].evaluate((el) => el.outerHTML);
    if (kind === "_exist_" && blockui1Content.includes("display: block")) {
      // logger.debug("_exist_, return");
      return "success";
    }
    if (kind === "_not_exist_" && !blockui1Content.includes("display: block")) {
      // logger.debug("_not_exist_, return");
      return "success";
    }
    // logger.debug(`wait ${waitMs}ms (timeout: ${(timeoutMs - waitMs * (i - (i % 10))) / 1000}s)`);
    await sleep(waitMs);
  }
  logger.debug("timeout, return");
  return "timeout";
}

// ページ遷移は page.waitForNavigation() で拾えないので、読み込みGIFが現れて消えるのを検出することにする
// XXX: 10s はてきとう
async function maEyesWaitLoading(page: Page, waitGIFMs = 10_000): Promise<void> {
  const resultWaitSpinner = await maEyesWaitLoadingSpinnerGIF(page, "_exist_", waitGIFMs);
  if (resultWaitSpinner === "timeout") {
    return;
  }
  await sleep(500); // XXX: 500ms はてきとう
  const resultWaitSpinner2 = await maEyesWaitLoadingSpinnerGIF(page, "_not_exist_", waitGIFMs);
  if (resultWaitSpinner2 === "timeout") {
    return;
  }
}

async function maEyesCalendarSelectYearMonth(page: Page, year: number, month: number): Promise<void> {
  await debugREPLMayWait();

  // select year
  // <select class="ui-datepicker-year" data-handler="selectYear" data-event="change" aria-label="select year">
  await page.locator(`select.ui-datepicker-year`).fill(String(year));
  await maEyesWaitLoading(page);

  // select month
  const month0 = (month - 1).toString();
  // <select class="ui-datepicker-month" data-handler="selectMonth" data-event="change" aria-label="select month">
  await page.locator(`select.ui-datepicker-month`).fill(month0);
  await maEyesWaitLoading(page);
}

async function maEyesCalendarSelectWeek(page: Page, iWeek: number): Promise<boolean> {
  await debugREPLMayWait();
  const trs = await page.$$(`table.ui-datepicker-calendar tr`);
  const tr = trs[iWeek];
  const tds = await tr.$$(`td.calendar-date`);
  if (tds.length === 0) {
    // 月火水木金土日
    assert.ok(iWeek === 0);
    return false;
  }
  assert.ok(iWeek > 0);
  const td = tds[0];
  const txt = await td.evaluate((el) => el.textContent);
  const week = ["日", "土", "水", "木", "水", "火", "月"][tds.length - 1];
  logger.info(`click: ${txt}(${week})`);
  await td.click();
  await maEyesWaitLoading(page);
  return true;
}

/**
 * ES2024 Promise.withResolvers
 * ref: node_modules/typescript/lib/lib.es2024.promise.d.ts
 */
function PromiseWithResolvers<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: any) => void;
} {
  const ret = {} as any;
  ret.promise = new Promise((resolve, reject) => {
    ret.resolve = resolve;
    ret.reject = reject;
  });
  return ret;
}

async function pptrBrowserPage(): Promise<[Browser, Page]> {
  logger.debug("open chromium");

  const browser = await (async () => {
    if (cliOptsGlobal.zPptrConnectUrl !== undefined) {
      return puppeteer.connect({
        // ConnectOptions
        acceptInsecureCerts: cliOptsGlobal.ignoreHttps,
        defaultViewport: null,
        browserURL: cliOptsGlobal.zPptrConnectUrl,
      });
    }
    return puppeteer.launch({
      // LaunchOptions - ConnectOptions
      acceptInsecureCerts: cliOptsGlobal.ignoreHttps,
      defaultViewport: null, // これが無いと800x600になる https://github.com/puppeteer/puppeteer/blob/main/docs/api.md#puppeteerconnectoptions
      // LaunchOptions
      handleSIGINT: cliOptsGlobal.zPptrLaunchHandleSigint,
      headless: cliOptsGlobal.zPptrLaunchHeadless,
      devtools: cliOptsGlobal.zPptrLaunchDevTools,
      args: cliOptsGlobal.zPptrLaunchArgs,
    });
  })();

  const page = await browser.newPage();
  // @ts-expect-error override page.locator()
  page.locatorOriginal = page.locator;
  // @ts-expect-error override page.locator()
  page.locator = (selector) => pptrPageLocatorWithLogDebug(page, selector);

  page.on("console", (msg) => {
    logger.debug("log from Puppeteer (Chromium browser):", msg.text());
  });

  // @ts-expect-error for debugREPL()
  globalThis.browser = browser;
  // @ts-expect-error for debugREPL()
  globalThis.page = page;

  return [browser, page];
}

async function pptrEnd(browser: Browser): Promise<void> {
  if (cliOptsGlobal.zPptrConnectUrl === undefined) {
    browser.close();
  } else {
    browser.disconnect();
  }
}

async function pptrCookieLoad(browser: Browser, cookiePath: string): Promise<void> {
  const cookies: Awaited<ReturnType<Browser["cookies"]>> = jsonParsePath(cookiePath);
  logger.debug(`browser.setCookie(): ${JSON.stringify(cookies)}`);
  await browser.setCookie(...cookies);
}

async function pptrCookieSave(browser: Browser, cookiePath: string): Promise<void> {
  logger.info("browser.cookies()");
  const cookies = await browser.cookies();
  const s = JSON.stringify(cookies, null, 2) + "\n";
  logger.info(`writeFile ${cookiePath}`);
  fs.writeFileSync(cookiePath, s);
}

// @ts-expect-error for debugREPL()
globalThis.pptrPageLocatorWithLogDebug = pptrPageLocatorWithLogDebug;
function pptrPageLocatorWithLogDebug<Selector extends string>(page: Page, selector: Selector): Locator<NodeFor<Selector>> {
  logger.debug(`page.locator(${selector})`);
  // @ts-expect-error page.locatorOriginal() is defined by us
  const ret = page.locatorOriginal(selector);
  return ret;
}

async function sleep(milliSeconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliSeconds));
}

// ref: https://github.com/tj/commander.js/blob/v12.1.0/lib/command.js
function strNodeOptionsRemoveInspect(arg: string): string {
  // Remove:
  //  --inspect[=[host:]port]
  //  --inspect-brk[=[host:]port]
  //  --inspect-port=[host:]port
  //  --inspect-publish-uid=stderr,http
  //  --inspect-wait=[host:]port
  //  --inspect=[host:]port
  // ↑ "=" may be [ \t]+

  // --inspect* [host:]port
  // not tested
  for (const match of arg.matchAll(/(?<=^| )--inspect\S* (\d+:)?\d+(?=$| )/g)) {
    arg = arg.replace(match[0], ``);
  }
  // --inspect-publish-uid stderr,http
  // not tested
  for (const match of arg.matchAll(/(?<=^| )--inspect-publish-uid\S*(stderr|http)(?=$| )/g)) {
    arg = arg.replace(match[0], ``);
  }
  // --inspect*
  for (const match of arg.matchAll(/(?<=^| )--inspect\S*(?=$| )/g)) {
    arg = arg.replace(match[0], ``);
  }
  return arg;
}

function strSnip(s: string, len: number) {
  s = s.replaceAll(/\r?\n/g, "⏎");
  if (s.length <= len) return s;
  len = Math.floor(len / 2);
  return `${s.slice(0, len)} ... ${s.slice(s.length - len)}`;
}

function unreachable(): never {
  throw new AppErrorStack("BUG: unreachable");
}

// -----------------------------------------------------------------------------
// domain types

type Date_ = string; // "7/27(月)" "8/1(土)"
export type { Date_ as Date };
export type ProjectName = string;
export type ProjectID = string;

export interface Kousu {
  version: "3.0.0";
  projects: { [projectID: ProjectID]: ProjectName };
  works: {
    date: Date_; // "7/27(月)" "8/1(土)"
    begin: string; // "09:00"
    end: string; // "17:30"
    yokujitsu: boolean;
    kyukei: number; // 0.0
    yasumi: "" | "全休" | "午前" | "午後";
    sagyou: number; // 7.5
    fumei: number; // 0.0
    hours: {
      [projectID: ProjectID]: number; // "project0": 0.0
    };
  }[];
}

// compatibility with old format (JSON: "version": "0.3.0")

interface Kinmu030 {
  date: string; // "7/27(月)" "8/1(土)"
  begin: string; // "09:00"
  end: string; // "17:30"
  yokujitsu: boolean;
  kyukei: number; // 0.0
  yasumi: "" | "全休" | "午前" | "午後";
}

interface Jisseki030 {
  sagyou: number; // 0.0
  fumei: number | null; // 0.0; 前後の月は null; NOTE: 3.0.0 では 0.0
  jisseki: {
    [projectId: string]: number; // "proj1": 0.0
  };
}

interface Kousu030 {
  version: "0.3.0";
  projects: { [projectId: string]: ProjectName };
  jissekis: (Kinmu030 & Jisseki030)[]; // NOTE: 3.0.0 では "works"
}

// compatibility with old format (JSON: "version": "0.1.0")

interface Kinmu010 {
  date: string; // "7/27(月)" "8/1(土)"
  begin: string; // "09:00"
  end: string; // "17:30"
  yokujitsu: boolean;
  kyukei: string; // "0.0"; NOTE: 0.3.0 では number
  yasumi: "" | "全休" | "午前" | "午後";
}

interface Jisseki010 {
  sagyou: string; // "0.0"; NOTE: 0.3.0 では number
  fumei: string; // "0.0"; 前後の月は ""; NOTE: 0.3.0 では null, 3.0.0 では 0.0
  jisseki: {
    [projectId: string]: string; // "proj1": "0.0"; NOTE: 0.3.0 では null, 3.0.0 では 0.0
  };
}

interface Kousu010 {
  version: "0.1.0";
  projects: { [projectId: string]: ProjectName };
  jissekis: (Kinmu010 & Jisseki010)[];
}

export function kousuLoadJSON(path: string): Kousu {
  const j = jsonParsePath(path);
  return kousuValidateJSON(j);
}

export function kousuValidateJSON(j: any /* Kousu | Kousu030 | Kousu010 */): Kousu {
  const strSnip_ = (s: string | undefined) => (s === undefined ? "undefined" : strSnip(s, 50));

  j = v8.deserialize(v8.serialize(j));

  kousuValidateAssert(isObject(j), `must be {"version":"3.0.0", ...}, but: ${strSnip_(JSON.stringify(j))}`);
  if (j.version === "0.3.0" || j.version === "0.1.0") {
    j = kousuValidateJSON030(j);
  }
  kousuValidateAssert(j.version === "3.0.0", `.version must be "3.0.0", but: ${strSnip_(JSON.stringify(j.version))}`);
  kousuValidateAssert(isObject(j.projects), `.projects must be like {"project0":"projectName 0", ...}, but: ${strSnip_(JSON.stringify(j.projects))}`);
  for (const [projectID, projectName] of Object.entries(j.projects)) {
    kousuValidateAssert(typeof projectName === "string", `.projects.${projectID} must be string, but: ${strSnip_(JSON.stringify(projectName))}`);
  }
  kousuValidateAssert(Array.isArray(j.works), `.works must be like [{"date":"7/27(月)", "begin":"09:00", "end":"17:30", "yokujitsu":false, "kyukei": 0.0, "yasumi":""|"全休"|"午前"|"午後", sagyou:7.5, fumei:0.0, work:{"project0":0.0}}], but: ${strSnip_(JSON.stringify(j.works))}`);
  for (const [iWork, work] of j.works.entries()) {
    kousuValidateAssert(isObject(work), `.works[${iWork}] must be like {"date":"7/27(月)", "begin":"09:00", "end":"17:30", "yokujitsu":false, "kyukei": 0.0, "yasumi":""|"全休"|"午前"|"午後", sagyou:7.5, fumei:0.0, work:{"project0":0.0}}, but: ${strSnip_(JSON.stringify(work))}`);
    kousuValidateAssert(typeof work.date === "string", `.works[${iWork}].date must be string ("7/27(月)"), but: ${strSnip_(JSON.stringify(work.date))}`);
    kousuValidateAssert(typeof work.begin === "string", `.works[${iWork}].begin must be string ("09:00"), but: ${strSnip_(JSON.stringify(work.begin))}`);
    kousuValidateAssert(typeof work.end === "string", `.works[${iWork}].end must be string ("17:30"), but: ${strSnip_(JSON.stringify(work.end))}`);
    kousuValidateAssert(typeof work.yokujitsu === "boolean", `.works[${iWork}].yokujitsu must be boolean, but: ${strSnip_(JSON.stringify(work.yokujitsu))}`);
    kousuValidateAssert(typeof work.kyukei === "number", `.works[${iWork}].kyukei must be number, but: ${strSnip_(JSON.stringify(work.kyukei))}`);
    kousuValidateAssert(["", "全休", "午前", "午後"].includes(work.yasumi), `.works[${iWork}].yasumi must be "" | "全休" | "午前" | "午後", but: ${strSnip_(JSON.stringify(work.yasumi))}`);
    kousuValidateAssert(typeof work.sagyou === "number", `.works[${iWork}].sagyou must be number, but: ${strSnip_(JSON.stringify(work.sagyou))}`);
    kousuValidateAssert(typeof work.fumei === "number", `.works[${iWork}].fumei must be number, but: ${strSnip_(JSON.stringify(work.fumei))}`);
    kousuValidateAssert(isObject(work.hours), `.works[${iWork}].hours must be object, but: ${strSnip_(JSON.stringify(work.hours))}`);
    for (const [projectID, hours] of Object.entries(work.hours)) {
      kousuValidateAssert(typeof hours === "number", `.works[${iWork}].work.${projectID} must be number, but: ${strSnip_(JSON.stringify(hours))}`);
    }
  }
  return j;
}

function kousuValidateJSON030(j: any /* Kousu030 | Kousu010 */): asserts j is Kousu {
  j = v8.deserialize(v8.serialize(j));

  const e = (msg: string) => {
    throw new AppError(`invalid JSON: ${msg}`);
  };
  assert.ok(j.version === "0.3.0" || j.version === "0.1.0");
  if (j.projects === undefined) e(`"projects" not defined, must be object ({"project": "projectName"})`);
  if (!isObject(j.projects)) e(`"projects" must be object ({"project": "projectName"})`);
  if (j.jissekis === undefined) e(`"jissekis" not defined, must be array`);
  if (!Array.isArray(j.jissekis)) e(`"projects" must be array`);

  if (j.version === "0.1.0") {
    logger.debug(`convert JSON: .version: "0.1.0" -> "0.3.0"`);
    j.version = "0.3.0";
    for (const [i, jisseki] of j.jissekis.entries()) {
      logger.debug(`convert JSON: .jissekis[${i}].kyukei: "${jisseki.kyukei}" -> ${Number(jisseki.kyukei)}`);
      jisseki.kyukei = Number(jisseki.kyukei);
      logger.debug(`convert JSON: .jissekis[${i}].sagyou: "${jisseki.sagyou}" -> ${Number(jisseki.sagyou)}`);
      jisseki.sagyou = Number(jisseki.sagyou);
      if (jisseki.fumei === "") {
        logger.debug(`convert JSON: .jissekis[${i}].fumei: "" -> null`);
        jisseki.fumei = null;
      } else {
        logger.debug(`convert JSON: .jissekis[${i}].fumei: "${jisseki.fumei}" -> ${Number(jisseki.fumei)}`);
        jisseki.fumei = Number(jisseki.fumei);
      }
      for (const [j, jisseki2] of Object.entries(jisseki.jisseki)) {
        logger.debug(`convert JSON: .jissekis[${i}].jisseki.${j}: "${jisseki2}" -> ${Number(jisseki2)}`);
        jisseki.jisseki[j] = Number(jisseki2);
      }
    }
  }

  assert.ok(j.version === "0.3.0");
  logger.debug(`convert JSON: .version: "0.3.0" -> "3.0.0"`);
  j.version = "3.0.0";
  logger.debug(`convert JSON: .jissekis[].jisseki -> .works[].hours`);
  j.works = j.jissekis;
  delete j.jissekis;
  for (const [i, work] of j.works.entries()) {
    work.hours = work.jisseki;
    delete work.jisseki;
    if (work.fumei === null) {
      logger.debug(`convert JSON: .jissekis[${i}].fumei: null -> 0.0`);
      work.fumei = 0.0;
    }
  }

  return j;
}

// : asserts expr をつけると型チェックが厳しくなって面倒だった
function kousuValidateAssert(expr: boolean, msg: string) /*: asserts expr */ {
  if (!expr) throw new AppError(`invalid JSON: ${msg}`);
}

/*
NODE_OPTIONS="--enable-source-maps --import @power-assert/node" KOUSU_TEST=1 kousu
NODE_OPTIONS="--enable-source-maps --import @power-assert/node --inspect-wait" KOUSU_TEST=1 kousu
*/
if (process.env.KOUSU_TEST) {
  const { KOUSU_TEST, ...env } = process.env;
  const d = fs.mkdtempSync("kousu-test-");
  const f = path.join(d, "test.json");
  const testInvalid = (j: string, message: RegExp) => {
    fs.writeFileSync(f, j);
    assert.throws(() => kousuLoadJSON(f), { message });
  };
  const testValid = (j: string): Kousu => {
    fs.writeFileSync(f, j);
    return kousuLoadJSON(f);
  };
  // prettier-ignore
  try {
    testInvalid(`xxx`,                                                                                                                                                                       /^invalid JSON: kousu-test-.+?test.json: Unexpected token 'x', "xxx" is not valid JSON$/);
    testInvalid(`[]`,                                                                                                                                                                        /^invalid JSON: must be \{"version":"3.0.0", \.\.\.}, but: \[]$/);
    testInvalid(`{"version":[]}`,                                                                                                                                                            /^invalid JSON: \.version must be "3\.0\.0", but: \[]$/);
    testInvalid(`{"version":"3.0.0"}`,                                                                                                                                                       /^invalid JSON: \.projects must be like \{"project0":"projectName 0", \.\.\.}, but: undefined$/);
    testInvalid(`{"version":"3.0.0","projects":null}`,                                                                                                                                       /^invalid JSON: \.projects must be like \{"project0":"projectName 0", \.\.\.}, but: null$/);
    testInvalid(`{"version":"3.0.0","projects":{"project0":null}}`,                                                                                                                          /^invalid JSON: \.projects\.project0 must be string, but: null$/);
    testInvalid(`{"version":"3.0.0","projects":{}}`,                                                                                                                                         /^invalid JSON: \.works must be like \[\{"date":"7\/27\(月\)", "begin":"09:00", "end":"17:30", "yokujitsu":false, "kyukei": 0\.0, "yasumi":""\|"全休"\|"午前"\|"午後", sagyou:7\.5, fumei:0\.0, work:\{"project0":0\.0}}], but: undefined$/);
    testInvalid(`{"version":"3.0.0","projects":{},"works":[null]}`,                                                                                                                          /^invalid JSON: \.works\[0] must be like \{"date":"7\/27\(月\)", "begin":"09:00", "end":"17:30", "yokujitsu":false, "kyukei": 0\.0, "yasumi":""\|"全休"\|"午前"\|"午後", sagyou:7\.5, fumei:0\.0, work:\{"project0":0\.0}}, but: null$/);
    testInvalid(`{"version":"3.0.0","projects":{},"works":[{}]}`,                                                                                                                            /^invalid JSON: \.works\[0]\.date must be string \("7\/27\(月\)"\), but: undefined$/);
    testInvalid(`{"version":"3.0.0","projects":{},"works":[{"date":""}]}`,                                                                                                                   /^invalid JSON: \.works\[0]\.begin must be string \("09:00"\), but: undefined$/);
    testInvalid(`{"version":"3.0.0","projects":{},"works":[{"date":"","begin":""}]}`,                                                                                                        /^invalid JSON: \.works\[0]\.end must be string \("17:30"\), but: undefined$/);
    testInvalid(`{"version":"3.0.0","projects":{},"works":[{"date":"","begin":"","end":""}]}`,                                                                                               /^invalid JSON: \.works\[0]\.yokujitsu must be boolean, but: undefined$/);
    testInvalid(`{"version":"3.0.0","projects":{},"works":[{"date":"","begin":"","end":"","yokujitsu":false}]}`,                                                                             /^invalid JSON: \.works\[0]\.kyukei must be number, but: undefined$/);
    testInvalid(`{"version":"3.0.0","projects":{},"works":[{"date":"","begin":"","end":"","yokujitsu":false,"kyukei":0.0}]}`,                                                                /^invalid JSON: \.works\[0]\.yasumi must be "" \| "全休" \| "午前" \| "午後", but: undefined$/);
    testInvalid(`{"version":"3.0.0","projects":{},"works":[{"date":"","begin":"","end":"","yokujitsu":false,"kyukei":0.0,"yasumi":""}]}`,                                                    /^invalid JSON: \.works\[0]\.sagyou must be number, but: undefined$/);
    testInvalid(`{"version":"3.0.0","projects":{},"works":[{"date":"","begin":"","end":"","yokujitsu":false,"kyukei":0.0,"yasumi":"","sagyou":0.0}]}`,                                       /^invalid JSON: \.works\[0]\.fumei must be number, but: undefined$/);
    testInvalid(`{"version":"3.0.0","projects":{},"works":[{"date":"","begin":"","end":"","yokujitsu":false,"kyukei":0.0,"yasumi":"","sagyou":0.0,"fumei":0.0}]}`,                           /^invalid JSON: \.works\[0]\.hours must be object, but: undefined$/);
    testInvalid(`{"version":"3.0.0","projects":{},"works":[{"date":"","begin":"","end":"","yokujitsu":false,"kyukei":0.0,"yasumi":"","sagyou":0.0,"fumei":0.0,"hours":{"project0":null}}]}`, /^invalid JSON: \.works\[0]\.work\.project0 must be number, but: null$/);
    testValid(`{"version":"3.0.0","projects":{},"works":[{"date":"","begin":"","end":"","yokujitsu":false,"kyukei":0.0,"yasumi":"","sagyou":0.0,"fumei":0.0,"hours":{"project0":0.0}}]}`);
    testValid(`{"version":"0.3.0","projects":{},"jissekis":[{"date":"","begin":"","end":"","yokujitsu":false,"kyukei":0.0,"yasumi":"","sagyou":0.0,"fumei":0.0,"jisseki":{"project0":0.0}}]}`);
    testValid(`{"version":"0.3.0","projects":{},"jissekis":[{"date":"","begin":"","end":"","yokujitsu":false,"kyukei":0.0,"yasumi":"","sagyou":0.0,"fumei":null,"jisseki":{"project0":0.0}}]}`);
    testValid(`{"version":"0.1.0","projects":{},"jissekis":[{"date":"","begin":"","end":"","yokujitsu":false,"kyukei":"0.0","yasumi":"","sagyou":"0.0","fumei":"0.0","jisseki":{"project0":"0.0"}}]}`);
    testValid(`{"version":"0.1.0","projects":{},"jissekis":[{"date":"","begin":"","end":"","yokujitsu":false,"kyukei":"0.0","yasumi":"","sagyou":"0.0","fumei":"","jisseki":{"project0":"0.0"}}]}`);
    "breakpoint".match(/breakpoint/);
  } finally {
    fs.unlinkSync(f);
    fs.rmdirSync(d);
  }
}

// -----------------------------------------------------------------------------
// command - import-kinmu

// prettier-ignore
program
  .command("import-kinmu")
  .description("MA-EYESにログインして「勤務時間取込」「保存」を行う")
  .action(importKinmu);

async function importKinmu(opts: {}): Promise<void> {
  if (commandNoRun) return;
  const [browser, page] = await pptrBrowserPage();
  await maEyesLogin(page);
  await maEyesCalendarSelectYearMonth(page, cliOptsGlobal.month[0], cliOptsGlobal.month[1]);

  await debugREPLMayWait();
  // prettier-ignore
  if (0) {
    // <table class="ui-datepicker-calendar">
    // td class:
    // - .ui-datepicker-other-month .ui-datepicker-unselectable .ui-state-disabled  前月・翌月の選択できないセル
    // - .calendar-date          平日 土日 祝日 全て (.ui-datepicker-other-month 以外)
    // - .holiday                土日 祝日
    // - .inputed                入力済（灰色） (inputtedのtypo)
    await page.$$eval(`table.ui-datepicker-calendar td.ui-datepicker-other-month`, async (els) => els.map((el) => { console.log(el); /*debugger;*/ return el.textContent })); // 前月・翌月の選択できないセル; "", "", ...
    await page.$$eval(`table.ui-datepicker-calendar td.calendar-date`, async (els) => els.map((el) => { console.log(el); /*debugger;*/ return el.textContent })); // 平日 土日 祝日 全て (.ui-datepicker-other-month 以外); "1", "2", ..., "28"/"29"/"30"/"31"
    await page.$$eval(`table.ui-datepicker-calendar td.holiday`, async (els) => els.map((el) => { console.log(el); /*debugger;*/ return el.textContent })); // 土日 祝日
  }
  // .ui-datepicker-other-month と .calendar-date 合わせて7の倍数（月火水木金土日 * n）になるはず
  {
    const nOther = (await page.$$(`table.ui-datepicker-calendar td.ui-datepicker-other-month`)).length;
    const nThis = (await page.$$(`table.ui-datepicker-calendar td.calendar-date`)).length;
    logger.debug(`(table.ui-datepicker-calendar td.ui-datepicker-other-month):${nOther} (table.ui-datepicker-calendar td.calendar-date):${nThis}`);
    if ((nOther + nThis) % 7 !== 0) {
      logger.warn(`BUG: (table.ui-datepicker-calendar td.ui-datepicker-other-month):${nOther} + (table.ui-datepicker-calendar td.calendar-date):${nThis} === ${nOther + nThis} is not multiple of 7`);
    }
  }

  // 2020-08
  // |月 |火 |水 |木 |金 |土 | 日
  // |   |   |   |   |   | 1<| 2 |
  // | 3<| 4 | 5 | 6 | 7 | 8 | 9 |
  // |10<|11 |12 |13 |14 |15 |16 |
  // |17<|18 |19 |20 |21 |22 |23 |
  // |24<|25 |26 |27 |28 |29 |30 |
  // |31<|   |   |   |   |   |   |
  //
  // 2025-01
  // |月 |火 |水 |木 |金 |土 | 日
  // |   |   | 1<| 2 | 3 | 4 | 5 |
  // | 6<| 7 | 8 | 9 |10 |11 |12 |
  // |13<|14 |15 |16 |17 |18 |19 |
  // |20<|21 |22 |23 |24 |25 |26 |
  // |27<|28 |29 |30 |31 |   |   |
  //
  //  < をクリック、勤務時間取込、保存
  const nWeek = (await page.$$(`table.ui-datepicker-calendar tr`)).length;
  const nDays = (await page.$$(`table.ui-datepicker-calendar td.calendar-date`)).length;
  for (let iWeek = 0; iWeek < nWeek; iWeek++) {
    if (!(await maEyesCalendarSelectWeek(page, iWeek))) {
      continue;
    }
    // <button id="workResultView:j_idt52" name="workResultView:j_idt52" class="ui-button ..."
    //   onclick="PrimeFaces.ab({s:&quot;workResultView:j_idt52&quot;,u:&quot;workResultView&quot;});return false;"
    //   type="submit" role="button" aria-disabled="false">
    //   <span class="ui-button-text ui-c">勤務時間取込</span></button>
    logger.info("勤務時間取込");
    // // page.evaluate doesn't wait
    // await page.evaluate('PrimeFaces.ab({s:"workResultView:j_idt52",u:"workResultView"});');
    // // ; -> Error: Evaluation failed: SyntaxError: Unexpected token ';'
    // await page.waitForFunction('PrimeFaces.ab({s:"workResultView:j_idt52",u:"workResultView"});');
    // // never return? debug again
    // await page.waitForFunction("PrimeFaces.ab({s:\"workResultView:j_idt52\",u:\"workResultView\"})");
    await page.locator(`#workResultView\\:j_idt52`).click();
    await maEyesWaitLoading(page);

    // <button id="workResultView:j_idt50:saveButton" name="workResultView:j_idt50:saveButton"
    //   class="ui-button ..."
    //   onclick="PrimeFaces.bcn(this,event,[function(event){MA.Utils.reflectEditingCellValue();},function(event){PrimeFaces.ab({s:&quot;workResultView:j_idt50:saveButton&quot;,u:&quot;workResultView&quot;});return false;}]);"
    //   tabindex="0" type="submit" role="button" aria-disabled="false">
    //   <span class="ui-button-icon-left ui-icon ui-c fa fa-save"></span>
    //   <span class="ui-button-text ui-c">保存</span></button>
    logger.info("保存");
    // // throws: Error: Evaluation failed: TypeError: Cannot read property 'preventDefault' of undefined
    // //   at Object.bcn (https://.../maeyes/javax.faces.resource/core.js.xhtml?ln=primefaces&v=6.3-SNAPSHOT:520:34)
    // await page.evaluate(
    //   "PrimeFaces.bcn(this,event,[function(event){MA.Utils.reflectEditingCellValue();},function(event){PrimeFaces.ab({s:\"workResultView:j_idt50:saveButton\",u:\"workResultView\"});return false;}]);"
    // );
    // // halts
    // await Promise.all([page.waitForNavigation(), page.click("#workResultView\\:j_idt50\\:saveButton")]);
    await page.click("#workResultView\\:j_idt50\\:saveButton");
    await maEyesWaitLoading(page);

    logger.debug("next");
  }

  await pptrEnd(browser);
  logger.debug("bye");
  return cliCommandExit(0);
}

// -----------------------------------------------------------------------------
// command - get

if (process.env.KOUSU_TEST) {
  const { KOUSU_TEST, KOUSU_MA_URL, KOUSU_MA_USER, KOUSU_MA_PASS, ...env } = process.env;
  let r; // result of child_process.spawnSync()
  let out, err; // previous stdout, stderr

  r = child_process.spawnSync(`kousu get`, { encoding: "utf8", env, shell: true, stdio: "pipe" });
  assert.ok(r.signal === null && !("error" in r) && r.status === 1 && r.stdout === "" && r.stderr !== "");
  assert.match(r.stderr, /^error: required option '--ma-pass <pass>' not specified(\r?\n)$/);
  [out, err] = [r.stdout, r.stderr];

  env.KOUSU_MA_URL = "https://example.com";
  env.KOUSU_MA_USER = "user";
  env.KOUSU_MA_PASS = "pass";

  r = child_process.spawnSync(`kousu get`, { encoding: "utf8", env, shell: true, stdio: "pipe" });
  assert.ok(r.signal === null && !("error" in r) && r.status === 1 && r.stdout === "" && r.stderr !== "");
  assert.match(r.stderr, / -o, --out-json <path> が必要です(\r?\n)$/);
  [out, err] = [r.stdout, r.stderr];

  // r = child_process.spawnSync(`kousu get kousu.json`, { encoding: "utf8", env, shell: true, stdio: "pipe" });

  r = child_process.spawnSync(`kousu get kousu.json arg2`, { encoding: "utf8", env, shell: true, stdio: "pipe" });
  assert.ok(r.signal === null && !("error" in r) && r.status === 1 && r.stdout === "" && r.stderr !== "");
  assert.match(r.stderr, / too many arguments: kousu.json arg2(\r?\n)$/);
  [out, err] = [r.stdout, r.stderr];

  r = child_process.spawnSync(`kousu get -o`, { encoding: "utf8", env, shell: true, stdio: "pipe" });
  assert.ok(r.signal === null && !("error" in r) && r.status === 1 && r.stdout === "" && r.stderr !== "");
  assert.ok(r.stderr === `error: option '-o, --out-json <path>' argument missing\n`);
  [out, err] = [r.stdout, r.stderr];

  // r = child_process.spawnSync(`kousu get -o kousu.json`, { encoding: "utf8", env, shell: true, stdio: "pipe" });

  r = child_process.spawnSync(`kousu get -o kousu.json arg1`, { encoding: "utf8", env, shell: true, stdio: "pipe" });
  assert.ok(r.signal === null && !("error" in r) && r.status === 1 && r.stdout === "" && r.stderr !== "");
  assert.match(r.stderr, / -o kousu.json arg1 は両方同時に指定できません; -o のみ指定することを推奨します(\r?\n)$/);
  [out, err] = [r.stdout, r.stderr];

  r = child_process.spawnSync(`kousu get -o kousu.json arg1 arg2`, { encoding: "utf8", env, shell: true, stdio: "pipe" });
  assert.ok(r.signal === null && !("error" in r) && r.status === 1 && r.stdout === "" && r.stderr !== "");
  assert.match(r.stderr, / too many arguments: arg1 arg2(\r?\n)$/);
  [out, err] = [r.stdout, r.stderr];

  r = child_process.spawnSync(`kousu get --out-csv=/dev/null`, { encoding: "utf8", env, shell: true, stdio: "pipe" });
  assert.ok(r.signal === null && !("error" in r) && r.status === 1 && r.stdout === "" && r.stderr !== "");
  assert.ok(r.stderr === `error: option '--out-csv <path>' argument '/dev/null' is invalid. --out-csv (KOUSU_OUT_CSV) は 0.2.0 で削除され、--out-json のみサポートになりました\n`);
  [out, err] = [r.stdout, r.stderr];
}

// prettier-ignore
program
  .command("get")
  .description("MA-EYESにログインして工数実績を取得する")
  .addOption(new commander.Option("--out-csv <path>").env("KOUSU_OUT_CSV").hideHelp().argParser(() => CLI.invalidArgument("--out-csv (KOUSU_OUT_CSV) は 0.2.0 で削除され、--out-json のみサポートになりました")))
  // .addOption(new commander.Option("--out-json <path>").env("KOUSU_OUT_JSON").hideHelp().argParser(() => CLI.invalidArgument("--out-json (KOUSU_OUT_JSON) は 0.3.0 で削除され、非オプション引数になりました")))
  .addOption(new commander.Option("-o, --out-json <path>", "JSONの出力パス")) // --out-json: 3.0.0 で復活
  // .addArgument(new commander.Argument("<file>", "JSONの出力パス")) // 引数でのJSONパスの指定は 3.0.0 で非推奨
  .allowExcessArguments(true)
  .action(get);

async function get(opts: { outJson?: string }, command: commander.Command): Promise<void> {
  if (commandNoRun) return;
  if (command.args.length === 1) {
    if (opts.outJson !== undefined) {
      throw new AppError(`-o ${opts.outJson} ${command.args[0]} は両方同時に指定できません; -o のみ指定することを推奨します`);
    }
    opts.outJson = command.args[0];
  }
  if (command.args.length > 1) {
    throw new AppError(`too many arguments: ${command.args.join(" ")}`);
  }
  if (opts.outJson === undefined) {
    throw new AppError(`-o, --out-json <path> が必要です`);
  }

  const [browser, page] = await pptrBrowserPage();
  await maEyesLogin(page);
  await maEyesCalendarSelectYearMonth(page, cliOptsGlobal.month[0], cliOptsGlobal.month[1]);

  const kousu = { version: "3.0.0", projects: {}, works: [] } as Kousu;

  const nWeek = (await page.$$(`table.ui-datepicker-calendar tr`)).length;
  const nDays = (await page.$$(`table.ui-datepicker-calendar td.calendar-date`)).length;
  for (let iWeek = 0; iWeek < nWeek; iWeek++) {
    if (!(await maEyesCalendarSelectWeek(page, iWeek))) {
      continue;
    }
    const works1 = await parseWeek2(page);
    const [projects, works2] = await parseWeek1(page);
    if (works1.length !== 7) {
      logger.error(`勤務時間表の形式が不正です: works1.length (${works1.length}) !== 7`);
    }
    if (works2.length !== 7) {
      logger.error(`工数実績入力表の形式が不正です: works2.length (${works2.length}) !== 7`);
    }

    for (const [i, kinmu] of works1.entries()) {
      if (kinmu === null) {
        continue;
      }
      kousu.works.push({ ...kinmu, ...works2[i] });
    }
    kousu.projects = { ...kousu.projects, ...projects };

    logger.debug("next");
  }

  // {
  //   "version": "3.0.0",
  //   "projects": {
  //     "proj1": "proj1 name"
  //     "proj2": "proj2 name"
  //   },
  //   "works": [
  //     {"date":"1/1(金)","begin":"00:00","end":"00:00","yokujitsu":false,"kyukei":0,"yasumi":"全休","sagyou":0,"fumei":0,"hours":{"project0":0,"project1":0}},
  //     {"date":"1/2(土)",...},
  //     ...
  //   ]
  // }
  // const json = `${JSON.stringify(works, null, 2)}\n`;
  // prettier-ignore
  const json = `{
  "version": ${JSON.stringify(kousu.version, null, 2)},
  "projects": {\n${Object.entries(kousu.projects).map(([projectID, projectName]) => `    ${JSON.stringify(projectID)}: ${JSON.stringify(projectName)}`).join(",\n")}
  },
  "works": [\n${kousu.works.map((kousu) => `    ${JSON.stringify(kousu)}`).join(",\n")}
  ]
}
`;

  fs.writeFileSync(opts.outJson, json);
  await pptrEnd(browser);
  logger.debug("bye");
  return cliCommandExit(0);
}

// 勤務表パース
// Omit<Kousu["works"], "hours"
async function parseWeek2(page: Page): Promise<(Omit<Kousu["works"][0], "sagyou" | "fumei" | "hours"> | null)[]> {
  const trs = await page.$$(`table#workResultView\\:j_idt69 tr`);
  assert.ok(trs.length === 6, `table#workResultView\\:j_idt69 tr: expected 6 trs (date 出社 退社 翌日 休憩 休み)`);

  const weekDates: string[] = []; //                7/27(月) 7/28(火) 7/29(水) 7/30(木) 7/31(金) 8/1(土) 8/2(日)
  const weekBegins: (string | null)[] = []; //      null     null     null     null     null     00:00   00:00
  const weekEnds: (string | null)[] = []; //        null     null     null     null     null     00:00   00:00
  const weekYokujitsus: (boolean | null)[] = []; // null     null     null     null     null     false   false
  const weekKyukeis: (string | null)[] = []; //     null     null     null     null     null     0.0     0.0
  const weekYasumis: (string | null)[] = []; //     null     null     null     null     null     全休    全休
  // -> [{"date":"8/1(土)", "begin":"09:00", "end":"17:30", "yokujitu":false, "kyukei": "0.0", "yasumi":""|"全休"|"午前"|"午後"}]

  // trs[0]: weekDates
  {
    const [row, name] = [1, ""];
    const tds = await trs[row - 1].$$(`td`);
    assert.ok(tds.length === 8 && (await tds[0].evaluate((el) => (el as any).textContent)) === name, `row:${row}`);
    for (let i = 1; i < tds.length; i++) {
      const txt = await tds[i].evaluate((el) => el.textContent);
      assert.ok(txt !== null, `row:${row} name:${name} i:${i}`);
      const match = txt.match(/(\d\d?)\/(\d\d?)\((月|火|水|木|金|土|日)\)/);
      assert.ok(match !== null, `row:${row} name:${name} i:${i} txt:${txt}`);
      weekDates.push(match[0]);
    }
  }

  // trs[1]: weekBegins
  {
    const [row, name] = [2, "出社"];
    const tds = await trs[row - 1].$$(`td`);
    assert.ok(tds.length === 8 && (await tds[0].evaluate((el) => (el as any).textContent)) === name, `row:${row}`);
    for (let i = 1; i < tds.length; i++) {
      const inputs = await tds[i].$$(`input`);
      if (inputs.length === 0) {
        // 前後の月
        weekBegins.push(null);
        continue;
      }
      const value = await inputs[0].evaluate((el) => el.getAttribute("value")); // "00:00"
      assert.ok(value !== null, `row:${row} name:${name} i:${i}`);
      weekBegins.push(value);
    }
  }

  // trs[2]: weekEnds
  {
    const [row, name] = [3, "退社"];
    const tds = await trs[row - 1].$$(`td`);
    assert.ok(tds.length === 8 && (await tds[0].evaluate((el) => (el as any).textContent)) === name, `row:${row}`);
    for (let i = 1; i < tds.length; i++) {
      const inputs = await tds[i].$$(`input`);
      if (inputs.length === 0) {
        // 前後の月
        weekEnds.push(null);
        continue;
      }
      const value = await inputs[0].evaluate((el) => el.getAttribute("value")); // "00:00"
      assert.ok(value !== null, `row:${row} name:${name} i:${i}`);
      weekEnds.push(value);
    }
  }

  // trs[3]: weekYokujitsus
  {
    const [row, name] = [4, "翌日"];
    const tds = await trs[row - 1].$$(`td`);
    assert.ok(tds.length === 8 && (await tds[0].evaluate((el) => (el as any).textContent)) === name, `row:${row}`);
    for (let i = 1; i < tds.length; i++) {
      const inputs = await tds[i].$$(`input`);
      if (inputs.length === 0) {
        // 前後の月
        weekYokujitsus.push(null);
        continue;
      }
      const value = await inputs[0].evaluate((el) => el.checked);
      assert.ok(typeof value === "boolean", `row:${row} name:${name} i:${i}`);
      weekYokujitsus.push(value);
    }
  }

  // trs[4]: weekKyukeis
  {
    const [row, name] = [5, "休憩"];
    const tds = await trs[row - 1].$$(`td`);
    assert.ok(tds.length === 8 && (await tds[0].evaluate((el) => (el as any).textContent)) === name, `row:${row}`);
    for (let i = 1; i < tds.length; i++) {
      const inputs = await tds[i].$$(`input`);
      if (inputs.length === 0) {
        // 前後の月
        weekKyukeis.push(null);
        continue;
      }
      const value = await inputs[0].evaluate((el) => el.getAttribute("value"));
      assert.ok(value !== null, `row:${row} name:${name} i:${i}`);
      weekKyukeis.push(value);
    }
  }

  // trs[5]: weekYasumis
  {
    const [row, name] = [6, "休み"];
    const tds = await trs[row - 1].$$(`td`);
    assert.ok(tds.length === 8 && (await tds[0].evaluate((el) => (el as any).textContent)) === name, `row:${row}`);
    for (let i = 1; i < tds.length; i++) {
      const labels = await tds[i].$$(`label`);
      if (labels.length === 0) {
        // 前後の月
        weekYasumis.push(null);
        continue;
      }
      const text = await labels[0].evaluate((el) => el.textContent);
      assert.ok(text === "\u00a0" || text === "全休" || text === "午前" || text === "午後", `row:${row} name:${name} i:${i}`);
      weekYasumis.push(text === "\u00a0" ? "" : text);
    }
  }

  const ret: (Omit<Kousu["works"][0], "sagyou" | "fumei" | "hours"> | null)[] = [];
  for (let i = 0; i < weekDates.length; i++) {
    if (weekBegins[i] === null || weekEnds[i] === null || weekYokujitsus[i] === null || weekKyukeis[i] === null || weekYasumis[i] === null) {
      assert.ok(weekBegins[i] === null && weekEnds[i] === null && weekYokujitsus[i] === null && weekKyukeis[i] === null && weekYasumis[i] === null);
      ret.push(null);
      continue;
    }
    assert.ok(weekBegins[i] !== null && weekEnds[i] !== null && weekYokujitsus[i] !== null && weekKyukeis[i] !== null && weekYasumis[i] !== null);
    if (!Number.isFinite(Number(weekKyukeis[i]))) {
      throw new AppErrorStack(`BUG: 勤務時間表の形式が不正です (休憩: ${weekKyukeis[i]})`);
    }
    ret.push({
      date: weekDates[i],
      begin: weekBegins[i] as string,
      end: weekEnds[i] as string,
      yokujitsu: weekYokujitsus[i] as boolean,
      kyukei: Number(weekKyukeis[i]),
      yasumi: weekYasumis[i] as "" | "全休" | "午前" | "午後",
    });
  }

  return ret;
}

// 工数実績入力表パース
async function parseWeek1(page: Page): Promise<[Kousu["projects"], Pick<Kousu["works"][0], "sagyou" | "fumei" | "hours">[]]> {
  const projects = {} as Kousu["projects"];
  const works2 = [] as Pick<Kousu["works"][0], "sagyou" | "fumei" | "hours">[];

  const errMsg = "工数実績入力表の形式が不正です";

  // prettier-ignore
  if (0) {
    // 2024-10
    //             | th[0]  th[1]  th[2]  th[3]  th[4]         th[5]     th[6]     th[7]   th[8]   th[9]   th[10]  th[11]  th[12]
    // thead/tr[0] | (hidden)
    // thead/tr[1] |                                           作業時間  0.0       0.0     0.0     0.0     0.0     0.0     0.0
    // thead/tr[2] |                                           不明時間  &npsp;    7.5     7.5     7.5     7.5     0.0     0.0
    // thead/tr[3] | [ ]    *      *      項目No 名称          *         9/30(月)  1(火)   2(水)   3(木)   4(金)   5(土)   6(日)
    //             | td[0]  td[1]  td[2]  td[3]  td[4]         td[5]     td[6]     td[7]   td[8]   td[9]   td[10]  td[11]  td[12]
    // tbody/tr[0] | [ ]    *      *      proj1  [proj1]名称1  *         0.0       0.0     0.0     0.0     0.0     0.0     0.0
    // tbody/tr[1] | [ ]    *      *      proj2  [proj2]名称2  *         0.0       0.0     0.0     0.0     0.0     0.0     0.0
    await page.$$eval(`div#workResultView\\:items`, async (els) => els.map((el) => { console.log(el); /*debugger;*/ return el.textContent; }));
    await page.$$eval(`div#workResultView\\:items table`, async (els) => els.map((el) => { console.log(el); /*debugger;*/ return el.textContent; }));
    await page.$$eval(`div#workResultView\\:items table thead`, async (els) => els.map((el) => { console.log(el); /*debugger;*/ return el.textContent; }));
    await page.$$eval(`div#workResultView\\:items table thead tr`, async (els) => els.map((el) => { console.log(el); /*debugger;*/ return el.textContent; }));
    await page.$$eval(`div#workResultView\\:items table thead tr:nth-child(1)`, async (els) => els.map((el) => { console.log(el); /*debugger;*/ return el.textContent; })) // "   "
    await page.$$eval(`div#workResultView\\:items table thead tr:nth-child(2)`, async (els) => els.map((el) => { console.log(el); /*debugger;*/ return el.textContent; })) // "   作業時間 0.0 0.0 0.0 0.0 0.0 0.0 0.0"
    await page.$$eval(`div#workResultView\\:items table thead tr:nth-child(3)`, async (els) => els.map((el) => { console.log(el); /*debugger;*/ return el.textContent; })) // "   不明時間     7.5 7.5 7.5 7.5 7.5 7.5"
    await page.$$eval(`div#workResultView\\:items table thead tr:nth-child(4)`, async (els) => els.map((el) => { console.log(el); /*debugger;*/ return el.textContent; })) // " * ..."
    await page.$$eval(`div#workResultView\\:items table thead tr:nth-child(2) th`, async (els) => els.map((el) => { console.log(el); /*debugger;*/ return el.textContent?.trim(); })) // "", "", "", "", "", "作業時間", "0.0", "0.0", "0.0", "0.0", "0.0", "0.0", "0.0"
    await page.$$eval(`div#workResultView\\:items table thead tr:nth-child(3) th`, async (els) => els.map((el) => { console.log(el); /*debugger;*/ return el.textContent?.trim(); })) // "", "", "", "", "", "不明時間", "", "7.5", "7.5", "7.5", "7.5", "7.5", "7.5"
    await page.$$eval(`div#workResultView\\:items table thead tr:nth-child(4) th`, async (els) => els.map((el) => { console.log(el); /*debugger;*/ return el.textContent?.trim(); })) // "", "*", "*", "*", "項目No", "名称", "*", "9/30(月)", "1(火)", "2(水)", "3(木)", "4(金)", "5(土)", "6(日)"
    await page.$$eval(`div#workResultView\\:items table tbody tr`, async (els) => els.map((el) => { console.log(el); /*debugger;*/ return el.textContent; }));
    await page.$$eval(`div#workResultView\\:items table tbody tr:nth-child(1)`, async (els) => els.map((el) => { console.log(el); /*debugger;*/ return el.textContent; }));
    await page.$$eval(`div#workResultView\\:items table tbody tr:nth-child(1) td`, async (els) => els.map((el) => { console.log(el); /*debugger;*/ return el.textContent?.trim(); })); // "", "*", "", "proj1", "[proj1]名称1, "*", "0.0", "0.0", "0.0", "0.0", "0.0", "0.0", "0.0"
    // await page.$$eval(`div#workResultView\\:items table tbody tr:nth-child(2)`,
    // ...
  }

  {
    const trTxts = await page.$$eval(`div#workResultView\\:items table thead tr`, async (els) => els.map((el) => el.textContent));
    assert.ok(trTxts[0] !== null);
    assert.ok(trTxts[1] !== null);
    assert.ok(trTxts[2] !== null);
    assert.ok(trTxts[3] !== null);
    assert.match(trTxts[0], /^\s*$/);
    // assert.match(trTxts[0], /^\u00a0{13}$/);
    assert.match(trTxts[1], /^\s*作業時間/);
    assert.match(trTxts[2], /^\s*不明時間/);
    assert.match(trTxts[3], /項目No\s*名称/);
  }

  const timesSagyou = (await page.$$eval(`div#workResultView\\:items table thead tr:nth-child(2) th`, async (els) => els.map((el) => el.textContent?.trim())))
    .map((txt, i) => {
      if ([0, 1, 2, 3, 4].includes(i)) {
        assert.ok(txt === "");
        return null;
      }
      if (i === 5) {
        assert.ok(txt === "作業時間");
        return null;
      }
      if (!Number.isFinite(Number(txt))) {
        throw new AppErrorStack(`${errMsg}: 作業時間: ${txt})`);
      }
      return Number(txt);
    })
    .filter((v) => v !== null);

  const timesFumei = (await page.$$eval(`div#workResultView\\:items table thead tr:nth-child(3) th`, async (els) => els.map((el) => el.textContent?.trim())))
    .map((txt, i) => {
      if ([0, 1, 2, 3, 4].includes(i)) {
        assert.ok(txt === "");
        return null;
      }
      if (i === 5) {
        assert.ok(txt === "不明時間");
        return null;
      }
      if (!Number.isFinite(Number(txt))) {
        throw new AppErrorStack(`${errMsg}: 不明時間: ${txt})`);
      }
      return Number(txt);
    })
    .filter((v) => v !== null);

  assert.ok(timesSagyou.length === 7);
  assert.ok(timesFumei.length === 7);

  // await page.$$eval(`div#workResultView\\:items table tbody tr:nth-child(1) td`, async (els) => els.map((el) => { console.log(el); /*debugger;*/ return el.textContent?.trim() })); // "", "*", "", "proj1", "[proj1]名称1, "*", "0.0", "0.0", "0.0", "0.0", "0.0", "0.0", "0.0"
  // prettier-ignore
  const webProjIDs = await page.$$eval(`div#workResultView\\:items table tbody tr td:nth-child(4)`, async (els) => els.map((el) => el.textContent?.trim())).then((vals) => vals.map((val) => { assert.ok(val !== undefined); return val }));
  // prettier-ignore
  const webProjNames = await page.$$eval(`div#workResultView\\:items table tbody tr td:nth-child(5)`, async (els) => els.map((el) => el.textContent?.trim())).then((vals) => vals.map((val) => { assert.ok(val !== undefined); return val }));
  // prettier-ignore
  const webHours0Mon = await page.$$eval(`div#workResultView\\:items table tbody tr td:nth-child(7)`, async (els) => els.map((el) => el.textContent?.trim())).then((vals) => vals.map((val) => { assert.ok(val !== undefined); return parseFloat(val) }));
  // prettier-ignore
  const webHours1Tue = await page.$$eval(`div#workResultView\\:items table tbody tr td:nth-child(8)`, async (els) => els.map((el) => el.textContent?.trim())).then((vals) => vals.map((val) => { assert.ok(val !== undefined); return parseFloat(val) }));
  // prettier-ignore
  const webHours2Wed = await page.$$eval(`div#workResultView\\:items table tbody tr td:nth-child(9)`, async (els) => els.map((el) => el.textContent?.trim())).then((vals) => vals.map((val) => { assert.ok(val !== undefined); return parseFloat(val) }));
  // prettier-ignore
  const webHours3Thu = await page.$$eval(`div#workResultView\\:items table tbody tr td:nth-child(10)`, async (els) => els.map((el) => el.textContent?.trim())).then((vals) => vals.map((val) => { assert.ok(val !== undefined); return parseFloat(val) }));
  // prettier-ignore
  const webHours4Fri = await page.$$eval(`div#workResultView\\:items table tbody tr td:nth-child(11)`, async (els) => els.map((el) => el.textContent?.trim())).then((vals) => vals.map((val) => { assert.ok(val !== undefined); return parseFloat(val) }));
  // prettier-ignore
  const webHours5Sat = await page.$$eval(`div#workResultView\\:items table tbody tr td:nth-child(12)`, async (els) => els.map((el) => el.textContent?.trim())).then((vals) => vals.map((val) => { assert.ok(val !== undefined); return parseFloat(val) }));
  // prettier-ignore
  const webHours6Sun = await page.$$eval(`div#workResultView\\:items table tbody tr td:nth-child(13)`, async (els) => els.map((el) => el.textContent?.trim())).then((vals) => vals.map((val) => { assert.ok(val !== undefined); return parseFloat(val) }));
  const webHoursList = [webHours0Mon, webHours1Tue, webHours2Wed, webHours3Thu, webHours4Fri, webHours5Sat, webHours6Sun];
  logger.debug(`#workResultView: number of projects: ${webProjIDs.length}`);
  for (const webHours of webHoursList) {
    assert.ok(webHours.length === webProjIDs.length);
  }

  works2.push({
    sagyou: timesSagyou[0],
    fumei: timesFumei[0],
    hours: {},
  });
  works2.push({
    sagyou: timesSagyou[1],
    fumei: timesFumei[1],
    hours: {},
  });
  works2.push({
    sagyou: timesSagyou[2],
    fumei: timesFumei[2],
    hours: {},
  });
  works2.push({
    sagyou: timesSagyou[3],
    fumei: timesFumei[3],
    hours: {},
  });
  works2.push({
    sagyou: timesSagyou[4],
    fumei: timesFumei[4],
    hours: {},
  });
  works2.push({
    sagyou: timesSagyou[5],
    fumei: timesFumei[5],
    hours: {},
  });
  works2.push({
    sagyou: timesSagyou[6],
    fumei: timesFumei[6],
    hours: {},
  });
  for (const [i, webProjID] of webProjIDs.entries()) {
    projects[webProjID] = webProjNames[i];
    works2[0].hours[webProjID] = webHours0Mon[i];
    works2[1].hours[webProjID] = webHours1Tue[i];
    works2[2].hours[webProjID] = webHours2Wed[i];
    works2[3].hours[webProjID] = webHours3Thu[i];
    works2[4].hours[webProjID] = webHours4Fri[i];
    works2[5].hours[webProjID] = webHours5Sat[i];
    works2[6].hours[webProjID] = webHours6Sun[i];
  }

  return [projects, works2];
}

// -----------------------------------------------------------------------------
// command - put

// prettier-ignore
program
  .command("put")
  .description("MA-EYESにログインして工数実績を入力する")
  .addOption(new commander.Option("--in-csv <path>").env("KOUSU_IN_CSV").hideHelp().argParser(() => CLI.invalidArgument("--in-csv (KOUSU_IN_CSV) は 0.2.0 で削除され、--in-json のみサポートになりました")))
  .addOption(new commander.Option("--in-json <path>").env("KOUSU_IN_JSON").hideHelp().argParser(() => CLI.invalidArgument("--in-json (KOUSU_IN_JSON) は 0.3.0 で削除され、非オプション引数になりました")))
  .argument("<file>", "入力するJSONのパス")
  .action(put);

async function put(file: string, opts: {}): Promise<void> {
  if (commandNoRun) return;

  const kousu = kousuLoadJSON(file);

  const [browser, page] = await pptrBrowserPage();
  await maEyesLogin(page);
  await maEyesCalendarSelectYearMonth(page, cliOptsGlobal.month[0], cliOptsGlobal.month[1]);

  const nWeek = (await page.$$(`table.ui-datepicker-calendar tr`)).length;
  const nDays = (await page.$$(`table.ui-datepicker-calendar td.calendar-date`)).length;
  for (let iWeek = 0; iWeek < nWeek; iWeek++) {
    if (!(await maEyesCalendarSelectWeek(page, iWeek))) {
      continue;
    }
    // ["10/28(月)", ... "11/1(金)", "11/2(土)", "11/3(日)"]
    const webDates = (await page.$$eval(`table#workResultView\\:j_idt69 tr:nth-child(1) td`, async (els) => els.map((el) => el.textContent)))
      .map((val, i) => {
        assert.ok(val !== null);
        if (i === 0) {
          assert.ok(val === "");
          return null;
        }
        return val.trim();
      })
      .filter((val) => val !== null);
    assert.ok(webDates.length === 7);

    // prettier-ignore
    const webProjIDs = await page.$$eval(`div#workResultView\\:items table tbody tr td:nth-child(4)`, async (els) => els.map((el) => el.textContent?.trim())).then((vals) => vals.map((val) => { assert.ok(val !== undefined); return val }));
    // prettier-ignore
    const webProjNames = await page.$$eval(`div#workResultView\\:items table tbody tr td:nth-child(5)`, async (els) => els.map((el) => el.textContent?.trim())).then((vals) => vals.map((val) => { assert.ok(val !== undefined); return val }));
    // prettier-ignore
    const webHours0Mon = await page.$$eval(`div#workResultView\\:items table tbody tr td:nth-child(7)`, async (els) => els.map((el) => el.textContent?.trim())).then((vals) => vals.map((val) => { assert.ok(val !== undefined); return val }));
    // prettier-ignore
    const webHours1Tue = await page.$$eval(`div#workResultView\\:items table tbody tr td:nth-child(8)`, async (els) => els.map((el) => el.textContent?.trim())).then((vals) => vals.map((val) => { assert.ok(val !== undefined); return val }));
    // prettier-ignore
    const webHours2Wed = await page.$$eval(`div#workResultView\\:items table tbody tr td:nth-child(9)`, async (els) => els.map((el) => el.textContent?.trim())).then((vals) => vals.map((val) => { assert.ok(val !== undefined); return val }));
    // prettier-ignore
    const webHours3Thu = await page.$$eval(`div#workResultView\\:items table tbody tr td:nth-child(10)`, async (els) => els.map((el) => el.textContent?.trim())).then((vals) => vals.map((val) => { assert.ok(val !== undefined); return val }));
    // prettier-ignore
    const webHours4Fri = await page.$$eval(`div#workResultView\\:items table tbody tr td:nth-child(11)`, async (els) => els.map((el) => el.textContent?.trim())).then((vals) => vals.map((val) => { assert.ok(val !== undefined); return val }));
    // prettier-ignore
    const webHours5Sat = await page.$$eval(`div#workResultView\\:items table tbody tr td:nth-child(12)`, async (els) => els.map((el) => el.textContent?.trim())).then((vals) => vals.map((val) => { assert.ok(val !== undefined); return val }));
    // prettier-ignore
    const webHours6Sun = await page.$$eval(`div#workResultView\\:items table tbody tr td:nth-child(13)`, async (els) => els.map((el) => el.textContent?.trim())).then((vals) => vals.map((val) => { assert.ok(val !== undefined); return val }));
    const webHoursList = [webHours0Mon, webHours1Tue, webHours2Wed, webHours3Thu, webHours4Fri, webHours5Sat, webHours6Sun];
    logger.debug(`#workResultView: number of projects: ${webProjIDs.length}`);
    for (const webHours of webHoursList) {
      assert.ok(webHours.length === webProjIDs.length);
    }

    const mapDateWork = Object.fromEntries(kousu.works.map((work) => [work.date, work]));
    let thisWeekModified = false;

    for (const [iWebDate, webDate] of webDates.entries()) {
      const webHoursThisDate = webHoursList[iWebDate];
      const work = mapDateWork[webDate];
      if (work === undefined) {
        logger.debug(`${webDate} not found in JSON; skip`);
        continue;
      }
      for (const [iWebProj, webProjID] of webProjIDs.entries()) {
        const webHours = webHoursThisDate[iWebProj];
        const hourInput = work.hours[webProjID]?.toFixed(1);
        if (hourInput === undefined) {
          logger.warn(`webProjID ${webProjID} not found in 工数実績入力表; skip`);
          continue;
        }
        if (webHours === hourInput) {
          // logger.debug(`${webDate} ${webProjID} ${kousu.projects[webProjID]} ${webHours} -> ${hourInput}; skip`);
          continue;
        }
        logger.debug(`${webDate} ${webProjID} ${kousu.projects[webProjID]} ${webHours} -> ${hourInput}`);
        thisWeekModified = true;
        await debugREPLMayWait();
        // prettier-ignore
        if (0) {
          await page.$$eval(`div#workResultView\\:items table thead span::-p-text(作業時間)`, async (els) => els.map((el) => { console.log(el);  return el.textContent }));

          await page.$$eval(`div#workResultView\\:items table tbody tr:nth-child(1) td:nth-child(7)`, async (els) => els.map((el) => { console.log(el);  return el.textContent }));
          await page.$$eval(`div#workResultView\\:items table tbody tr:nth-child(2) td:nth-child(7)`, async (els) => els.map((el) => { console.log(el);  return el.textContent }));
          await page.$$eval(`div#workResultView\\:items table tbody tr:nth-child(1) td:nth-child(8)`, async (els) => els.map((el) => { console.log(el);  return el.textContent }));
          await page.locator(`div#workResultView\\:items table tbody tr:nth-child(1) td:nth-child(7)`).setTimeout(500).fill("7.7"); // cannnot
          await page.locator(`div#workResultView\\:items table tbody tr:nth-child(1) td:nth-child(7)`).setTimeout(500).click();
          await page.locator(`div#workResultView\\:items table tbody tr:nth-child(1) td:nth-child(7).ui-cell-editing`).setTimeout(500).wait(); // XXX: 先月の灰色になっているセルだとtimeout
          await page.keyboard.type("7.7");
          await page.keyboard.press("Tab"); // 値の確定・送信
          await maEyesWaitLoading(page);
        }
        if (0) {
          // 一旦テーブル外をクリックして、セル選択状態を解除
          // 入力テキスト全選択状態だと2回クリックする必要がある: 1回目のクリック: 全選択解除 → 2回目のクリック: 選択解除
          await page.locator(`div#workResultView\\:items table thead span::-p-text(作業時間)`).setTimeout(500).click();
          await page.locator(`div#workResultView\\:items table thead span::-p-text(作業時間)`).setTimeout(500).click();
        }
        await page.locator(`div#workResultView\\:items table tbody tr:nth-child(${iWebProj + 1}) td:nth-child(${7 + iWebDate})`).click(); // [select_all]: セルをクリックすることで入力済みの値が全選択される; ↑ をしておかないと全選択できない場合ある（セルが既に選択されている状態で更にクリックすると全選択にならない）
        await page.locator(`div#workResultView\\:items table tbody tr:nth-child(${iWebProj + 1}) td:nth-child(${7 + iWebDate}).ui-cell-editing`).wait(); // [select_all]: セルをクリックすることで入力済みの値が全選択される; ↑ をしておかないと全選択できない場合ある（セルが既に選択されている状態で更にクリックすると全選択にならない）
        await page.keyboard.type(hourInput); // [select_all] の状態で値を入力することで上書きできる
        await page.locator(`div#workResultView\\:items table thead span::-p-text(作業時間)`).setTimeout(500).click(); // 値の確定・送信
        await maEyesWaitLoading(page, 3_000); // 3s はてきとう
        await debugREPLMayWait();
      }
    }

    if (!thisWeekModified) {
      logger.debug("unchanged; skip 保存");
      continue;
    }
    logger.info("保存");
    await debugREPLMayWait();
    await page.locator(`#workResultView\\:j_idt50\\:saveButton`).click();
    await maEyesWaitLoading(page);
  }

  await pptrEnd(browser);
  logger.debug("bye");
  return cliCommandExit(0);
}
