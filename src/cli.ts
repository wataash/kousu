// SPDX-FileCopyrightText: Copyright (c) 2021-2025 Wataru Ashihara <wataash0607@gmail.com>
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @typescript-eslint/no-explicit-any */

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

import * as commander from "@commander-js/extra-typings";
import * as puppeteer from "puppeteer";
import { Browser, ElementHandle, Page } from "puppeteer";
import * as xmldom from "@xmldom/xmldom";
import * as xpath from "xpath";

import { Logger } from "./logger.js";

const __filename = url.fileURLToPath(import.meta.url);
const logger = new Logger();
const program = new commander.Command();
export const VERSION = "2.1.0";

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
  zPptrConnectUrl?: string;
  zPptrCookieLoad?: string;
  zPptrCookieSave?: string;
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
  .addOption(new commander.Option("--z-pptr-connect-url <url>").hideHelp().conflicts(["zPptrLaunchHandleSigint", "zPptrLaunchHeadless"]))
  .addOption(new commander.Option("--z-pptr-cookie-load <path>").hideHelp().conflicts(["zPptrCookieSave"]))
  .addOption(new commander.Option("--z-pptr-cookie-save <path>").hideHelp().conflicts(["zPptrCookieLoad"]))
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
// eslint-disable-next-line @typescript-eslint/no-unused-vars
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

// https://github.com/jonschlinkert/isobject/blob/master/index.js
function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object" && Array.isArray(value) === false;
}

async function maEyesLogin(page: Page): Promise<void> {
  if (cliOptsGlobal.zPptrCookieLoad !== undefined) {
    await pptrCookieLoad(page, cliOptsGlobal.zPptrCookieLoad);
    logger.debug(`page.goto ${cliOptsGlobal.maUrl}`);
    await Promise.all([page.waitForNavigation(), page.goto(cliOptsGlobal.maUrl)]);
    return;
  }

  logger.debug(`page.goto ${cliOptsGlobal.maUrl}`);
  await Promise.all([page.waitForNavigation(), page.goto(cliOptsGlobal.maUrl)]);

  // .../loginView.xhtml (login)
  // .../workResult.xhtml (already logged in; when using --pptr-connect-url)
  if (page.url().endsWith("/workResult.xhtml")) {
    logger.debug("already logged in");
    return;
  }

  const inputUser = await $x1(
    page,
    `//input[@data-p-label="ユーザコード"]`,
  );
  await page.evaluate((el, user) => (el.value = user), inputUser as unknown as HTMLInputElement, cliOptsGlobal.maUser);
  const inputPass = await $x1(
    page,
    `//input[@data-p-label="パスワード"]`,
  );
  await page.evaluate((el, pass) => (el.value = pass), inputPass as unknown as HTMLInputElement, cliOptsGlobal.maPass);
  const button = await $x1(page, `//div[@class="login-actions"]/button`);
  // XXX: 画面拡大率が100%でないと（主に --pptr-connect-url の場合）座標がずれて別のボタンが押される
  await Promise.all([page.waitForNavigation(), (button as unknown as HTMLButtonElement).click()]);
  if (cliOptsGlobal.zPptrCookieSave !== undefined) {
    await pptrCookieSave(page, cliOptsGlobal.zPptrCookieSave);
  }
}

// return false if timeout
async function maEyesWaitLoadingGIF(page: Page, kind: "appear" | "disappear", timeoutMs: number): Promise<"success" | "error" | "timeout"> {
  // logger.debug(`wait loading GIF ${kind}...`);
  const waitMs = 100;
  for (let i = 0; i < timeoutMs / waitMs; i++) {
    // <!-- 通常時; loading GIF: disappear -->
    // <div id="workResultView:j_idt50:j_idt51" class="ui-blockui-content ui-widget ui-widget-content ui-corner-all ui-helper-hidden ui-shadow"></div>
    // <div id="workResultView:j_idt57"         class="ui-blockui-content ui-widget ui-widget-content ui-corner-all ui-helper-hidden ui-shadow" style="left: 504.795px; top: 410.55px; z-index: 1327; display: none;">
    //   <!--                                                                                                                                                                                         ^^^^^^^^^^^^^^ -->
    //   <img id="workResultView:j_idt58" src="/maeyes/javax.faces.resource/loading.gif.xhtml?ln=image" alt="">
    // </div>
    // <!-- 画面遷移時; loading GIF: appear -->
    // <div id="workResultView:j_idt50:j_idt51" class="ui-blockui-content ui-widget ui-widget-content ui-corner-all ui-helper-hidden ui-shadow"></div>
    // <div id="workResultView:j_idt57"         class="ui-blockui-content ui-widget ui-widget-content ui-corner-all ui-helper-hidden ui-shadow" style="left: 504.795px; top: 410.55px; z-index: 1256; display: block;">
    //   <!--                                                                                                                                                                                         ^^^^^^^^^^^^^^^ -->
    //   <img id="workResultView:j_idt58" src="/maeyes/javax.faces.resource/loading.gif.xhtml?ln=image" alt="">
    // </div>
    // @ts-expect-error TODO
    const blockuiContent = await page.$x(`//div[contains(@class, "ui-blockui-content")]`);
    if (blockuiContent.length !== 2) {
      logger.warn(`BUG: number of $x(\`//div[contains(@class, "ui-blockui-content")]\`): ${blockuiContent.length}`);
      logger.warn(`wait 5s and return`);
      await sleep(5000);
      return "error";
    }
    const blockuiContent1 = await page.evaluate((el) => (el as unknown as HTMLElement).outerHTML, blockuiContent[1]);
    if (kind === "appear" && blockuiContent1.includes("display: block")) {
      // logger.debug("appears, return");
      return "success";
    }
    if (kind === "disappear" && !blockuiContent1.includes("display: block")) {
      // logger.debug("disappears, return");
      return "success";
    }
    // logger.debug(`wait ${waitMs}ms (timeout: ${(timeoutMs - waitMs * (i - (i % 10))) / 1000}s)`);
    await sleep(100);
  }
  logger.debug("timeout, return");
  return "timeout";
}

// ページ遷移は page.waitForNavigation() で拾えないので、読み込みGIFが現れて消え
// るのを検出することにする
// XXX: 30s はてきとう
async function maEyesWaitLoading(page: Page, waitGIFMs = 30_000): Promise<void> {
  const resultAppaer = await maEyesWaitLoadingGIF(page, "appear", waitGIFMs);
  if (resultAppaer === "timeout") {
    return;
  }
  await sleep(500); // XXX: 500ms はてきとう
  const resultDisappear = await maEyesWaitLoadingGIF(page, "disappear", waitGIFMs);
  if (resultDisappear === "timeout") {
    return;
  }
  await sleep(500); // XXX: 500ms はてきとう
}

async function maEyesCalendarSelectYearMonth(page: Page, year: number, month: number): Promise<void> {
  // select year
  {
    const year_ = year.toString();
    // <select class="ui-datepicker-year" data-handler="selectYear" data-event="change" aria-label="select year">
    const elem = await $x1(page, '//select[@class="ui-datepicker-year"]');
    logger.debug(`elem.select(${year_})`);
    const elems2 = await elem.select(year_);
    assert.ok(elems2.length === 1);
    assert.ok(elems2[0] === year_);
    await maEyesWaitLoading(page);
  }

  // select month
  {
    const month2 = (month - 1).toString();
    // <select class="ui-datepicker-month" data-handler="selectMonth" data-event="change" aria-label="select month">
    const elem = await $x1(page, `//select[@class="ui-datepicker-month"]`);
    logger.debug(`elem.select(${month2})`);
    const elems2 = await elem.select(month2);
    assert.ok(elems2.length === 1);
    assert.ok(elems2[0] === month2);
    await maEyesWaitLoading(page);
  }
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
        browserURL: cliOptsGlobal.zPptrConnectUrl,
        // BrowserOptions
        // @ts-expect-error TODO
        ignoreHTTPSErrors,
        // これが無いと800x600になる
        // https://github.com/puppeteer/puppeteer/blob/main/docs/api.md#pptrconnectoptions
        defaultViewport: null,
        // slowMo: 50, // for page.type
      });
    }
    return puppeteer.launch({
      // LaunchOptions
      handleSIGINT: cliOptsGlobal.zPptrLaunchHandleSigint,
      // ChromeArgOptions
      headless: cliOptsGlobal.zPptrLaunchHeadless,
      // https://peter.sh/experiments/chromium-command-line-switches/
      // opts: ["--window-position=20,20", "--window-size=1400,800"],
      // devtools: true,
      // BrowserOptions
      // @ts-expect-error TODO
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

async function pptrEnd(browser: Browser): Promise<void> {
  if (cliOptsGlobal.zPptrConnectUrl === undefined) {
    browser.close();
  } else {
    browser.disconnect();
  }
}

async function pptrCookieLoad(page: Page, cookiePath: string): Promise<void> {
  if (!fs.existsSync(cookiePath)) {
    // TODO: catch ENOENT instead
    throw new AppError(`cookie file (${cookiePath}) not found`);
  }
  const txt = fs.readFileSync(cookiePath, "utf8");
  const cookies: puppeteer.Protocol.Network.CookieParam[] = JSON.parse(txt);
  for (const cookie of cookies) {
    logger.debug(`page.setCookie(): ${JSON.stringify(cookie)}`);
    // eslint-disable-next-line no-await-in-loop
    // @ts-expect-error TODO
    await page.setCookie(cookie);
  }
}

async function pptrCookieSave(page: Page, cookiePath: string): Promise<void> {
  logger.info("page.cookies()");
  const cookiesObject = await page.cookies();
  const s = JSON.stringify(cookiesObject, null, 2) + "\n";
  logger.info(`writeFile ${cookiePath}`);
  fs.writeFileSync(cookiePath, s);
}

async function $x(
  page: Page | ElementHandle<Element>,
  expression: string,
  // @ts-expect-error TODO
): ReturnType<typeof page.$x> {
  // logger.debug(`$x(\`${expression}\`)`);
  // @ts-expect-error TODO
  return page.$x(expression);
}

async function $xn(
  page: Page | ElementHandle<Element>,
  expression: string,
  n: number,
): ReturnType<typeof $x> {
  const elementHandles = await $x(page, expression);
  assert.ok(elementHandles.length === n, expression);
}

async function $x1(
  page: Page | ElementHandle<Element>,
  expression: string,
): Promise<ElementHandle<Node>> {
  return (await $xn(page, expression, 1))[0];
}

async function sleep(milliSeconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliSeconds));
}

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

function unreachable(): never {
  throw new AppErrorStack("BUG: unreachable");
}

// -----------------------------------------------------------------------------
// domain types

export type ProjectName = string;

export interface Kinmu {
  date: string; // "7/27(月)" "8/1(土)"
  begin: string; // "09:00"
  end: string; // "17:30"
  yokujitsu: boolean;
  kyukei: number; // 0.0
  yasumi: "" | "全休" | "午前" | "午後";
}

export interface Jisseki {
  sagyou: number; // 0.0
  fumei: number | null; // 0.0; 前後の月は null
  jisseki: {
    [projectId: string]: number; // "proj1": 0.0
  };
}

export interface Kousu {
  version: string;
  projects: { [projectId: string]: ProjectName };
  jissekis: (Kinmu & Jisseki)[];
}

// compatibility with old format (JSON: "version": "0.1.0")

interface Kinmu010 {
  date: string; // "7/27(月)" "8/1(土)"
  begin: string; // "09:00"
  end: string; // "17:30"
  yokujitsu: boolean;
  kyukei: string; // "0.0"
  yasumi: "" | "全休" | "午前" | "午後";
}

interface Jisseki010 {
  sagyou: string; // "0.0"
  fumei: string; // "0.0"; 前後の月は ""
  jisseki: {
    [projectId: string]: string; // "proj1": "0.0"
  };
}

interface Kousu010 {
  version: string;
  projects: { [projectId: string]: ProjectName };
  jissekis: (Kinmu010 & Jisseki010)[];
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

  // <table class="ui-datepicker-calendar">
  // $x("//table[@class=\"ui-datepicker-calendar\"]/tbody/tr")
  // $x("//table[@class=\"ui-datepicker-calendar\"]/tbody/tr/td")
  // $x("//table[@class=\"ui-datepicker-calendar\"]/tbody/tr/td[@class=\" calendar-date\"]")  weekday
  // $x("//table[@class=\"ui-datepicker-calendar\"]/tbody/tr/td[@class=\"ui-datepicker-week-end calendar-date holiday\"]")  holiday
  // $x("//table[@class=\"-datepicker-calendar\"]/tbody/tr/td[@class=\" calendar-date\"]" or @class=\"ui-datepicker-week-end calendar-date holiday\"]")  workday or holiday

  // 2020-08
  // $x("//table[@class=\"ui-datepicker-calendar\"]/tbody/tr/td") -> (42)
  //  月       火       水       木       金       土       日
  //  [0]      [1]      [2]      [3]      [4]     C[5]  1   [6]  2
  // C[7] 3    [8] 4    [9] 5    [10] 6   [11] 7   [12] 8   [13] 9
  // C[14]10   [15]11   [16]12   [17]13   [18]14   [19]15   [20]16
  // C[21]17   [22]18   [23]19   [24]20   [25]21   [26]22   [27]23
  // C[28]24   [29]25   [30]26   [31]27   [32]28   [33]29   [34]30
  // C[35]31   [36]     [37]     [38]     [39]     [40]1    [41]
  // C: click & load & save
  // @ts-expect-error TODO
  const elemsCalendarDate = await page.$x(`//table[@class="ui-datepicker-calendar"]/tbody/tr/td`);
  for (let i = 0; i < elemsCalendarDate.length; i++) {
    // [XXX-$x-again]: We can't iterate over elemsCalendarDate:
    //   for (const [i, elem] of elemsCalendarDate.entries()) {
    //   since DOM is updated within the loop (just try it if you don't get it).
    // @ts-expect-error TODO
    const elemsCalendarDate2 = await page.$x(`//table[@class="ui-datepicker-calendar"]/tbody/tr/td`);
    const elemDate = elemsCalendarDate2[i];
    // @ts-expect-error TODO
    const txt = await elemDate.evaluate((el) => (el as unknown as HTMLElement).innerText);
    if (txt === "\u00A0") {
      // nbsp
      continue;
    }
    if (i % 7 !== 0 && txt !== "1") {
      // not monday nor 1st
      continue;
    }
    logger.info(`click: ${txt}(${["月", "火", "水", "木", "金", "土", "日"][i % 7]})`);
    // await Promise.all([page.waitForNavigation(), (elemDate as unknown as HTMLElement).click()]); // halts
    await (elemDate as unknown as HTMLElement).click();
    await maEyesWaitLoading(page);

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
    await Promise.all([maEyesWaitLoading(page), page.click("#workResultView\\:j_idt52")]);

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
    await Promise.all([maEyesWaitLoading(page), page.click("#workResultView\\:j_idt50\\:saveButton")]);

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
  .addOption(new commander.Option("-o, --out-json <path>", "JSONの出力パス"))
  // .addArgument(new commander.Argument("<file>", "JSONの出力パス"))
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

  // [{
  //   date: "7/27(月)";
  //   begin: "15:04";
  //   end: "15:04";
  //   yokujitsu: false;
  //   kyukei: 0;
  //   yasumi: "";
  //   sagyou: 0;
  //   fumei: 0;
  //   jisseki: {
  //     proj1: 0;
  //   }
  // }
  const kinmuJissekis: (Kinmu & Jisseki)[] = [];

  const projects: { [projectId: string]: ProjectName } = {};

  const elemsCalendarDate = await $x(page, `//table[@class="ui-datepicker-calendar"]/tbody/tr/td`);
  for (let i = 0; i < elemsCalendarDate.length; i++) {
    // click monday
    // see [XXX-$x-again]
    // @ts-expect-error TODO
    const elemsCalendarDate2 = await page.$x(`//table[@class="ui-datepicker-calendar"]/tbody/tr/td`);
    const elemDate = elemsCalendarDate2[i];
    // @ts-expect-error TODO
    const txt = await elemDate.evaluate((el) => (el as unknown as HTMLElement).innerText);
    // nbsp
    if (txt === "\u00A0") {
      continue;
    }
    if (i % 7 !== 0 && txt !== "1") {
      // not monday nor 1st
      continue;
    }
    logger.info(`click: ${txt}(${["月", "火", "水", "木", "金", "土", "日"][i % 7]})`);
    await Promise.all([maEyesWaitLoading(page), (elemDate as unknown as HTMLElement).click()]);

    const kinmus = await (async () => {
      const elem = await $x1(page, `//table[@id="workResultView:j_idt69"]`);
      const html = await elem.evaluate((el) => (el as unknown as HTMLElement).outerHTML);
      const kinmus = parseWeekKinmu(html); // Object.assign(kinmu, parseWeekKinmu(html));
      return kinmus;
    })();

    const [jissekis, projects_] = await (async () => {
      const elem = await $x1(page, `//div[@id="workResultView:items"]`);
      const html = await elem.evaluate((el) => (el as unknown as HTMLElement).outerHTML);
      return parseWeekJisseki(html);
    })();

    assert.ok(kinmus.length === 7);
    assert.ok(jissekis.length === 7);
    // TODO: projects_ が全ての週で一致するか確認

    for (const [i, kinmu] of kinmus.entries()) {
      if (kinmu === null) {
        continue;
      }
      kinmuJissekis.push(Object.assign({}, kinmu, jissekis[i]));
    }
    Object.assign(projects, projects_);

    logger.debug("next");
  }

  // {
  //   "version": "0.3.0",
  //   "projects": {
  //     "proj1": "proj1 name"
  //     "proj2": "proj2 name"
  //   },
  //   "jissekis": [
  //     {"date":"1/1(金)","begin":"00:00","end":"00:00","yokujitsu":false,"kyukei":0,"yasumi":"全休","sagyou":0,"fumei":0,"jisseki":{"proj1":0,"proj2":0}},
  //     {"date":"1/2(土)",...},
  //     ...
  //   ]
  // }
  // const json = `${JSON.stringify(kinmuJissekis, null, 2)}\n`;
  const json = `{
    "version": "0.3.0",
    "projects": ${JSON.stringify(projects, null, 2)
      .split("\n")
      .map((row) => `  ${row}`)
      .join("\n")},
    "jissekis": [\n${kinmuJissekis.map((kousu) => `    ${JSON.stringify(kousu)}`).join(",\n")}
    ]
  }
  `;

  fs.writeFileSync(opts.outJson, json);
  await pptrEnd(browser);
  logger.debug("bye");
  return cliCommandExit(0);
}

// 勤務表パース
function parseWeekKinmu(html: string): (Kinmu | null)[] {
  // TS2322
  // const x = (expression: string, node: any): ReturnType<typeof xpath.select> => {
  const x = (expression: string, node: any): xpath.SelectedValue[] => {
    // logger.debug(`xpath.select(\`${expression}\`)`);
    // TODO:
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore TODO: error TS2322: Type 'SelectReturnType' is not assignable to type 'SelectedValue[]'.
    return xpath.select(expression, node);
  };

  const doc = new xmldom.DOMParser({
    errorHandler: () => {
      /* nop; just to suppress error logs */
    },
    // @ts-expect-error TODO
  }).parseFromString(html);

  const trs = x(`//tr`, doc);
  assert.ok(trs.length === 6);

  const datumDate: string[] = []; //                7/27(月) 7/28(火) 7/29(水) 7/30(木) 7/31(金) 8/1(土) 8/2(日)
  const datumBegin: (string | null)[] = []; //      null     null     null     null     null     00:00   00:00
  const datumEnd: (string | null)[] = []; //        null     null     null     null     null     00:00   00:00
  const datumYokujitsu: (boolean | null)[] = []; // null     null     null     null     null     false   false
  const datumKyukei: (string | null)[] = []; //     null     null     null     null     null     0.0     0.0
  const datumYasumi: (string | null)[] = []; //     null     null     null     null     null     全休    全休
  // -> [{"date":"8/1(土)", "begin":"09:00", "end":"17:30", "yokujitu":false, "kyukei": "0.0", "yasumi":""|"全休"|"午前"|"午後"}]

  const checkTds = (row: number, tds: xpath.SelectedValue[], text0: string) => {
    assert.ok(tds.length === 8);
    // .data
    assert.ok((tds[0] as Element).textContent === text0);
  };

  // trs[0]: datumDate
  {
    const row = 1;
    const kind = "日付";
    const tds = x(`./td`, trs[0]);
    // debug: tds[6].innerHTML
    checkTds(row, tds, "");
    for (let i = 1; i < tds.length; i++) {
      const txt = (tds[i] as Element).textContent;
      assert.ok(txt !== null)
      const match = txt.match(/(\d\d?)\/(\d\d?)\((月|火|水|木|金|土|日)\)/);
      assert.ok(match !== null)
      datumDate.push(match[0]);
    }
  }

  // trs[1]: datumBegin
  {
    const row = 2;
    const kind = "出社";
    const tds = x(`./td`, trs[1]);
    checkTds(row, tds, kind);
    for (let i = 1; i < tds.length; i++) {
      const inputN = x(`.//input`, tds[i]) as Element[];
      if (inputN.length === 0) {
        // 前後の月
        datumBegin.push(null);
        continue;
      }
      const input = inputN[0];
      const value = input.getAttribute("value"); // "00:00"
      assert.ok(value !== null);
      datumBegin.push(value);
    }
  }

  // trs[2]: datumEnd
  {
    const row = 3;
    const kind = "退社";
    const tds = x(`./td`, trs[2]);
    checkTds(row, tds, kind);
    for (let i = 1; i < tds.length; i++) {
      const inputN = x(`.//input`, tds[i]) as Element[];
      if (inputN.length === 0) {
        // 前後の月
        datumEnd.push(null);
        continue;
      }
      const input = inputN[0];
      const value = input.getAttribute("value"); // "00:00"
      assert.ok(value !== null);
      datumEnd.push(value);
    }
  }

  // trs[3]: datumYokujitsu
  {
    const row = 4;
    const kind = "翌日";
    const tds = x(`./td`, trs[3]);
    checkTds(row, tds, kind);
    for (let i = 1; i < tds.length; i++) {
      const inputN = x(`.//input`, tds[i]) as Element[];
      if (inputN.length === 0) {
        // 前後の月
        datumYokujitsu.push(null);
        continue;
      }
      const input = inputN[0];
      const ariaChecked = input.getAttribute("aria-checked");
      assert.ok(ariaChecked === "true" || ariaChecked === "false");
      datumYokujitsu.push(ariaChecked === "true");
    }
  }

  // trs[4]: datumKyukei
  {
    const row = 5;
    const kind = "休憩";
    const tds = x(`./td`, trs[4]);
    checkTds(row, tds, kind);
    for (let i = 1; i < tds.length; i++) {
      const inputN = x(`.//input`, tds[i]) as Element[];
      if (inputN.length === 0) {
        // 前後の月
        datumKyukei.push(null);
        continue;
      }
      const input = inputN[0];
      const value = input.getAttribute("value");
      assert.ok(value !== null);
      datumKyukei.push(value);
    }
  }

  // trs[5]: datumYasumi
  {
    const row = 6;
    const kind = "休み";
    const tds = x(`./td`, trs[5]);
    checkTds(row, tds, kind);
    for (let i = 1; i < tds.length; i++) {
      const labelN = x(`.//label`, tds[i]) as Element[];
      if (labelN.length === 0) {
        // 前後の月
        datumYasumi.push(null);
        continue;
      }
      const label = labelN[0];
      const text = label.textContent;
      assert.ok(text === "&nbsp;" || text === "全休" || text === "午前" || text === "午後");
      datumYasumi.push(text === "&nbsp;" ? "" : text);
    }
  }

  const ret: (Kinmu | null)[] = [];
  for (let i = 0; i < datumDate.length; i++) {
    if (
      datumBegin[i] === null ||
      datumEnd[i] === null ||
      datumYokujitsu[i] === null ||
      datumKyukei[i] === null ||
      datumYasumi[i] === null
    ) {
      ret.push(null);
      continue;
    }
    assert.ok(!isNaN(parseFloat(datumKyukei[i] as string)));
    ret.push({
      date: datumDate[i],
      begin: datumBegin[i] as string,
      end: datumEnd[i] as string,
      yokujitsu: datumYokujitsu[i] as boolean,
      kyukei: parseFloat(datumKyukei[i] as string),
      yasumi: datumYasumi[i] as "" | "全休" | "午前" | "午後",
    });
  }

  return ret;
}

// 工数実績入力表パース
function parseWeekJisseki(html: string): [Jisseki[], { [projectId: string]: ProjectName }] {
  const jissekis: Jisseki[] = [];
  const projects: { [projectId: string]: ProjectName } = {};

  // TS2322
  // const x = (expression: string, node: any): ReturnType<typeof xpath.select> => {
  const x = (expression: string, node: any): xpath.SelectedValue[] => {
    // logger.debug(`xpath.select(\`${expression}\`)`);
    // TODO:
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore TODO: error TS2322: Type 'SelectReturnType' is not assignable to type 'SelectedValue[]'.
    return xpath.select(expression, node);
  };

  const x1 = (expression: string, node: any): ReturnType<typeof xpath.select1> => {
    logger.debug(`xpath.select1(\`${expression}\`)`);
    return xpath.select1(expression, node);
  };

  const assertText = (expression: string, node: any, data: string) => {
    const node2 = x1(expression, node) as Text;
    assert.ok(node2 !== undefined && node2.data === data);
    logger.debug(`$x(\`${expression}\`) === "${data}", ok`);
  };

  const doc = new xmldom.DOMParser({
    errorHandler: () => {
      /* nop; just to suppress error logs */
    },
    // @ts-expect-error TODO
  }).parseFromString(html);

  // debug with watching HTML:
  // - x(`tr[8]`, tbody).toString()
  // - x(`tr[8]/td[7]`, tbody).toString()
  // - x(`tr[8]/td[7]/div/div[1]`, tbody).toString()

  // TODO: 2/1 は月曜はじまりなのでテストケースとして良くない undefined が現れない
  // $x(`//div[@id="workResultView:items"]`)
  //
  //             | th[1]  th[2]  th[3]  th[4]  th[5]         th[6]     th[7]     th[8]   th[9]   th[10]  th[11]  th[12]  th[13]
  // thead/tr[1] | (ghost)
  // thead/tr[2] |                                           作業時間  0.0       0.0     0.0     0.0     0.0     0.0     0.0
  // thead/tr[3] |                                           不明時間  7.5       7.5     7.5     7.5     7.5     0.0     0.0
  // thead/tr[4] | [ ]    *      *      項目No 名称          *         7/27(月)  28(火)  29(水)  30(木)  31(金)  1(土)   2(日)
  //             | td[1]  td[2]  td[3]  td[4]  td[5]         td[6]     td[7]     td[8]   td[9]   td[10]  td[11]  td[12]  td[13]
  // tbody/tr[1] | [ ]                  proj1  [proj1]名称1            0.0       0.0     0.0     0.0     0.0     0.0     0.0
  // tbody/tr[2] | [ ]                  proj2  [proj2]名称2            0.0       0.0     0.0     0.0     0.0     0.0     0.0
  //
  // $x(`//thead[@id="workResultView:items_head"]/tr[2]/th/span[2]/text()`)       // "作業時間" 0.0 0.0 0.0 0.0 0.0 0.0 0.0
  // $x(`//thead[@id="workResultView:items_head"]/tr[2]/th[6]/span[2]/text()`)[0] // "作業時間"
  // $x(`//thead[@id="workResultView:items_head"]/tr[2]/th[7]/span[2]/text()`)[0] // (月) x.x
  // ...
  // $x(`//thead[@id="workResultView:items_head"]/tr[2]/th[13]/span[2]/text()`)[0] // (日) x.x
  // $x(`//thead[@id="workResultView:items_head"]/tr[3]/th/span[2]/text()`)       // "不明時間" 7.5 7.5 7.5 7.5 7.5 0.0 0.0
  // $x(`//thead[@id="workResultView:items_head"]/tr[3]/th[6]/span[2]/text()`)[0] // "不明時間"
  // $x(`//thead[@id="workResultView:items_head"]/tr[3]/th[7]/span[2]/text()`)[0] // (月) x.x
  // ...
  // $x(`//thead[@id="workResultView:items_head"]/tr[3]/th[13]/span[2]/text()`)[0] // (日) x.x
  // $x(`//thead[@id="workResultView:items_head"]/tr[4]/th[4]/span[2]/text()`)[0] // "項目No"
  // $x(`//thead[@id="workResultView:items_head"]/tr[4]/th[5]/span[2]/text()`)[0] // "名称"
  // $x(`//thead[@id="workResultView:items_head"]/tr[4]/th[6]/span[2]/text()`)[0] //
  // $x(`//thead[@id="workResultView:items_head"]/tr[4]/th[7]/span[2]/text()`)[0] // "2/1(月)"
  // $x(`//thead[@id="workResultView:items_head"]/tr[4]/th[8]/span[2]/text()`)[0] // "2(火)"
  // ...
  // $x(`//thead[@id="workResultView:items_head"]/tr[4]/th[13]/span[2]/text()`)[0] // "7(日)"
  // $x(`//tbody[@id="workResultView:items_data"]`)
  // $x(`//tbody[@id="workResultView:items_data"]/tr/td[4]/div/span/text()`) [項目No]
  // $x(`//tbody[@id="workResultView:items_data"]/tr/td[5]/div/span/text()`) // [名称]
  // $x(`//tbody[@id="workResultView:items_data"]/tr/td[6]/div/span/text()`) //
  // $x(`//tbody[@id="workResultView:items_data"]/tr/td[7]`) // [月]
  // ...
  // $x(`//tbody[@id="workResultView:items_data"]/tr/td[13]`) // [日]

  // html が <div id="workResultView:items" ... でなく <html ... だと
  // thead tbody が undefined になる…
  // * だと thead が取れるので何かおかしい
  // const thead = xpath.select1(`//thead[@id="workResultView:items_head"]`, doc); // undefined
  // const thead = xpath.select1(`//*[@id="workResultView:items_head"]`, doc);     // thead

  const thead = x1(`//thead[@id="workResultView:items_head"]`, doc);
  const tbody = x1(`//tbody[@id="workResultView:items_data"]`, doc);

  assertText(`//tr[2]/th[6]/span[2]/text()`, thead, "作業時間");
  assertText(`//tr[3]/th[6]/span[2]/text()`, thead, "不明時間");
  assertText(`//tr[4]/th[4]/span[2]/text()`, thead, "項目No");
  assertText(`//tr[4]/th[5]/span[2]/text()`, thead, "名称");

  // textContent: contains empty columns
  // const timesSagyou = (x(`tr[2]/th/span[2]`, thead) as Element[]).map((elem) => elem.textContent);

  const timesSagyou = (x(`tr[2]/th/span[2]`, thead) as Element[]).map((elem) => {
    if (elem.textContent === "" || elem.textContent === "作業時間") {
      return -1;
    }
    assert.ok(!isNaN(parseFloat(elem.textContent as string)));
    return parseFloat(elem.textContent as string);
  });
  const timesFumei = (x(`tr[3]/th/span[2]`, thead) as Element[]).map((elem) => {
    if (elem.textContent === "" || elem.textContent === "不明時間") {
      return null;
    }
    assert.ok(!isNaN(parseFloat(elem.textContent as string)));
    return parseFloat(elem.textContent as string);
  });
  timesSagyou.shift(); // -1 ("")
  timesSagyou.shift(); // -1 ("")
  timesSagyou.shift(); // -1 ("")
  timesSagyou.shift(); // -1 ("")
  timesSagyou.shift(); // -1 ("作業時間")
  timesFumei.shift(); // null ("")
  timesFumei.shift(); // null ("")
  timesFumei.shift(); // null ("")
  timesFumei.shift(); // null ("")
  timesFumei.shift(); // null ("不明時間")

  const dates = (x(`tr[4]/th/span[2]`, thead) as Element[]).map((elem) => elem.textContent as string);
  dates.shift();
  dates.shift();
  dates.shift(); // "項目No"
  dates.shift(); // "名称"
  dates.shift();
  // 7/27(月) 28(火) 29(水) 30(木) 31(金) 1(土) 2(日)
  // という形式で使いづらいので捨てる

  for (const [name, var_] of [
    ["timesSagyou", timesSagyou],
    ["timesFumei", timesFumei],
    ["dates", dates],
  ]) {
    assert.ok(var_.length === 7, `${name}`);
  }

  const projectIds = (x(`tr/td[4]/div/span`, tbody) as Element[]).map((elem) => elem.textContent as string);
  const projectNames = (x(`tr/td[5]/div/span`, tbody) as Element[]).map((elem) => elem.textContent as string);

  // const projects_text: Text[] = x('tr/td[7]', tbody);
  // 月 ... 日
  const parseJisseki = (s: string, trtd: string): number => {
    assert.ok(!isNaN(parseFloat(s as string)));
    return parseFloat(s as string);
  };
  const jissekis0 = (x(`tr/td[7]`, tbody) as Element[]).map((elem) =>
    parseJisseki(elem.textContent as string, `tr/td[7]`),
  );
  const jissekis1 = (x(`tr/td[8]`, tbody) as Element[]).map((elem) =>
    parseJisseki(elem.textContent as string, `tr/td[8]`),
  );
  const jissekis2 = (x(`tr/td[9]`, tbody) as Element[]).map((elem) =>
    parseJisseki(elem.textContent as string, `tr/td[9]`),
  );
  const jissekis3 = (x(`tr/td[10]`, tbody) as Element[]).map((elem) =>
    parseJisseki(elem.textContent as string, `tr/td[10]`),
  );
  const jissekis4 = (x(`tr/td[11]`, tbody) as Element[]).map((elem) =>
    parseJisseki(elem.textContent as string, `tr/td[11]`),
  );
  const jissekis5 = (x(`tr/td[12]`, tbody) as Element[]).map((elem) =>
    parseJisseki(elem.textContent as string, `tr/td[12]`),
  );
  const jissekis6 = (x(`tr/td[13]`, tbody) as Element[]).map((elem) =>
    parseJisseki(elem.textContent as string, `tr/td[13]`),
  );

  logger.debug(`number of projects: ${projectIds.length}`);
  for (const [name, var_] of [
    ["projectNames", projectNames],
    ["jissekis0", jissekis0],
    ["jissekis1", jissekis1],
    ["jissekis2", jissekis2],
    ["jissekis3", jissekis3],
    ["jissekis4", jissekis4],
    ["jissekis5", jissekis5],
    ["jissekis6", jissekis6],
  ]) {
    assert.ok(var_.length === projectIds.length, `${name}`);
  }

  jissekis.push({
    sagyou: timesSagyou[0],
    fumei: timesFumei[0],
    jisseki: {},
  });
  jissekis.push({
    sagyou: timesSagyou[1],
    fumei: timesFumei[1],
    jisseki: {},
  });
  jissekis.push({
    sagyou: timesSagyou[2],
    fumei: timesFumei[2],
    jisseki: {},
  });
  jissekis.push({
    sagyou: timesSagyou[3],
    fumei: timesFumei[3],
    jisseki: {},
  });
  jissekis.push({
    sagyou: timesSagyou[4],
    fumei: timesFumei[4],
    jisseki: {},
  });
  jissekis.push({
    sagyou: timesSagyou[5],
    fumei: timesFumei[5],
    jisseki: {},
  });
  jissekis.push({
    sagyou: timesSagyou[6],
    fumei: timesFumei[6],
    jisseki: {},
  });
  for (const [i, projectId] of projectIds.entries()) {
    projects[projectId] = projectNames[i];
    jissekis[0].jisseki[projectId] = jissekis0[i];
    jissekis[1].jisseki[projectId] = jissekis1[i];
    jissekis[2].jisseki[projectId] = jissekis2[i];
    jissekis[3].jisseki[projectId] = jissekis3[i];
    jissekis[4].jisseki[projectId] = jissekis4[i];
    jissekis[5].jisseki[projectId] = jissekis5[i];
    jissekis[6].jisseki[projectId] = jissekis6[i];
  }

  return [jissekis, projects];
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

  let  compat: "0.1.0" | null = null;

  const kousu: Kousu | Kousu010 = (() => {
    const j = JSON.parse(fs.readFileSync(file, "utf8")) as Kousu | Kousu010;
    const e = (msg: string) => {
      throw new AppError(`invalid JSON: ${msg}`);
    };
    // eslint-disable-next-line no-warning-comments
    // TODO: more strict check with quicktype
    if (j.version === undefined) e(`"version" not defined, must be "0.3.0"`);
    if (j.version !== "0.1.0" && j.version !== "0.3.0") e(`"version" must be "0.3.0"`);
    if (j.version === "0.1.0") compat = "0.1.0";
    if (j.projects === undefined) e(`"projects" not defined, must be object ({"project": "projectName"})`);
    if (!isObject(j.projects)) e(`"projects" must be object ({"project": "projectName"})`);
    if (j.jissekis === undefined) e(`"jissekis" not defined, must be array`);
    if (!Array.isArray(j.jissekis)) e(`"projects" must be array`);
    return j;
  })();

  const mapDateJisseki = (() => {
    if (compat === "0.1.0") {
      return (kousu as Kousu010).jissekis.reduce((acc, jisseki) => {
        acc[jisseki.date] = jisseki;
        return acc;
      }, {} as { [date: string]: typeof kousu.jissekis[number] });
    }
    return (kousu as Kousu).jissekis.reduce((acc, jisseki) => {
      acc[jisseki.date] = jisseki;
      return acc;
    }, {} as { [date: string]: typeof kousu.jissekis[number] });
  })();

  const [browser, page] = await pptrBrowserPage();
  await maEyesLogin(page);
  await maEyesCalendarSelectYearMonth(page, cliOptsGlobal.month[0], cliOptsGlobal.month[1]);

  const elemsCalendarDate = await $x(page, `//table[@class="ui-datepicker-calendar"]/tbody/tr/td`);
  for (let i = 0; i < elemsCalendarDate.length; i++) {
    // click monday
    // see [XXX-$x-again]
    // @ts-expect-error TODO
    const elemsCalendarDate2 = await page.$x(`//table[@class="ui-datepicker-calendar"]/tbody/tr/td`);
    const elemDate = elemsCalendarDate2[i];
    // @ts-expect-error TODO
    const txt = await elemDate.evaluate((el) => (el as unknown as HTMLElement).innerText);
    // nbsp; 前後の月
    if (txt === "\u00A0") {
      continue;
    }
    if (i % 7 !== 0 && txt !== "1") {
      // not monday nor 1st
      continue;
    }
    logger.info(`click: ${txt}(${["月", "火", "水", "木", "金", "土", "日"][i % 7]})`);
    await Promise.all([maEyesWaitLoading(page), (elemDate as unknown as HTMLElement).click()]);

    // (null | string)[7]
    // ["10/28(月)", ... "11/1(金)", "11/2(土)", "11/3(日)"]
    const dates = await (async () => {
      // $x(`//table[@id="workResultView:j_idt69"]//tr[1]/td`)
      const elems = await $xn(
        page,
        `//table[@id="workResultView:j_idt69"]//tr[1]/td`,
        8,
      );
      return Promise.all(
        // @ts-expect-error TODO
        elems.slice(1).map(async (elem) => elem.evaluate((el) => (el as unknown as HTMLElement).innerText))
      );
    })();

    let modified = false;
    for (const [iDate, date] of dates.entries()) {
      const jisseki = mapDateJisseki[date];
      if (jisseki === undefined) {
        logger.debug(`${date} not found in JSON; skip`);
        continue;
      }
      // $x(`//tbody[@id="workResultView:items_data"]/tr/td[4]/text()`)
      const elemsProject = await $x(page, `//tbody[@id="workResultView:items_data"]/tr/td[4]`);
      const projects = await Promise.all(
        // @ts-expect-error TODO
        elemsProject.map(async (elem) => elem.evaluate((el) => (el as unknown as HTMLElement).innerText))
      );
      for (const [iProj, project] of projects.entries()) {
        const timeJisseki = (() => {
          const tmp = jisseki.jisseki[project];
          if (tmp === undefined) {
            logger.warn(`project ${project} not found in 工数実績入力表; skip`);
            return null;
          }
          if (typeof tmp === "string") {
            if (compat !== "0.1.0") {
              throw new AppError(`BUG: jisseki.jisseki[project]: ${tmp}`);
            }
            return tmp;
          }
          return tmp.toFixed(1);
        })();
        if (timeJisseki === null) {
          continue;
        }
        // $x(`//tbody[@id="workResultView:items_data"]/tr[1]/td[7]`)[0]
        const elem = await $x1(
          page,
          `//tbody[@id="workResultView:items_data"]/tr[${iProj + 1}]/td[${iDate + 7}]`,
        );
        // await elem.evaluate((el) => (el as unknown as HTMLElement).innerText = "9.9");
        const txt = await elem.evaluate((el) => (el as unknown as HTMLElement).innerText);
        if (txt === timeJisseki) {
          continue;
        }
        modified = true;
        logger.debug(`${date} ${project} ${kousu.projects[project]} ${timeJisseki}`);
        await (elem as unknown as HTMLElement).click();
        await page.keyboard.type(timeJisseki);
        // 値の確定・送信
        // $x(`//table[@id="workResultView:j_idt69"]//tr[1]/td[1]`)
        await Promise.all([
          maEyesWaitLoading(page),
          (
            (await $x1(
              page,
              `//table[@id="workResultView:j_idt69"]//tr[1]/td[1]`,
            )) as unknown as HTMLElement
          ).click(),
        ]);
        "breakpoint".match(/breakpoint/);
      }
      "breakpoint".match(/breakpoint/);
    }

    if (!modified) {
      logger.debug("unchanged; skip 保存");
      continue;
    }
    logger.info("保存");
    await Promise.all([maEyesWaitLoading(page), page.click("#workResultView\\:j_idt50\\:saveButton")]);
    "breakpoint".match(/breakpoint/);
  }

  await pptrEnd(browser);
  logger.debug("bye");
  return cliCommandExit(0);
}
