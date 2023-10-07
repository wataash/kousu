// SPDX-FileCopyrightText: Copyright (c) 2021-2023 Wataru Ashihara <wataash0607@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import * as fs from "node:fs";
import * as path from "node:path";

import * as commander from "commander";
import { program } from "commander";
import * as puppeteer from "puppeteer";
import * as xmldom from "@xmldom/xmldom";
import * as xpath from "xpath";

import { Logger } from "./logger";

const logger = new Logger();

// -----------------------------------------------------------------------------
// lib

class AppError extends Error {
  constructor(message: string, withStack = false) {
    // https://www.typescriptlang.org/docs/handbook/release-notes/typescript-2-2.html
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    if (withStack) {
      logger.errors(message);
    } else {
      logger.error(message);
    }
  }
}

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

// https://github.com/jonschlinkert/isobject/blob/master/index.js
function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object" && Array.isArray(value) === false;
}

async function maEyesLogin(
  page: puppeteer.Page,
  urlLogin: string,
  user: string,
  pass: string,
  pathCookieLoad: string | null,
  pathCookieSave: string | null
): Promise<void> {
  if (pathCookieLoad !== null) {
    await puppeteerCookieLoad(page, pathCookieLoad);
    logger.debug(`page.goto ${urlLogin}`);
    await Promise.all([page.waitForNavigation(), page.goto(urlLogin)]);
    return;
  }

  logger.debug(`page.goto ${urlLogin}`);
  await Promise.all([page.waitForNavigation(), page.goto(urlLogin)]);

  // .../loginView.xhtml (login)
  // .../workResult.xhtml (already logged in; when using --puppeteer-connect-url)
  if (page.url().endsWith("/workResult.xhtml")) {
    logger.debug("already logged in");
    return;
  }

  const inputUser = await $x1(
    page,
    `//input[@data-p-label="ユーザコード"]`,
    "「ユーザーコード」のinput elementが見つかりません"
  );
  await page.evaluate((el, user) => (el.value = user), inputUser as unknown as HTMLInputElement, user);
  const inputPass = await $x1(
    page,
    `//input[@data-p-label="パスワード"]`,
    "「パスワード」のinput elementが見つかりません"
  );
  await page.evaluate((el, pass) => (el.value = pass), inputPass as unknown as HTMLInputElement, pass);
  const button = await $x1(page, `//div[@class="login-actions"]/button`, "「ログイン」ボタンが見つかりません");
  // XXX: 画面拡大率が100%でないと（主に --puppeteer-connect-url の場合）座標がずれて別のボタンが押される
  await Promise.all([page.waitForNavigation(), (button as unknown as HTMLButtonElement).click()]);
  if (pathCookieSave !== null) {
    await puppeteerCookieSave(page, pathCookieSave);
  }
}

// return false if timeout
async function maEyesWaitLoadingGIF(
  page: puppeteer.Page,
  kind: "appear" | "disappear",
  timeoutMs: number
): Promise<"success" | "error" | "timeout"> {
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
async function maEyesWaitLoading(page: puppeteer.Page, waitGIFMs = 30_000): Promise<void> {
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

async function maEyesSelectYearMonth(page: puppeteer.Page, year: number, month: number): Promise<void> {
  const msg = "カレンダーの形式が不正です";

  // select year
  {
    const year_ = year.toString();
    // <select class="ui-datepicker-year" data-handler="selectYear" data-event="change" aria-label="select year">
    const elem = await $x1(page, '//select[@class="ui-datepicker-year"]', msg);
    logger.debug(`elem.select(${year_})`);
    const elems2 = await elem.select(year_);
    if (elems2.length !== 1) {
      throw new AppError(`failed to select year (elems2.length: ${elems2.length})`);
    }
    if (elems2[0] !== year_) {
      throw new AppError(`failed to select year (elems2[0]: ${elems2[0]})`);
    }
    await maEyesWaitLoading(page);
  }

  // select month
  {
    const month2 = (month - 1).toString();
    // <select class="ui-datepicker-month" data-handler="selectMonth" data-event="change" aria-label="select month">
    const elem = await $x1(page, `//select[@class="ui-datepicker-month"]`, msg);
    logger.debug(`elem.select(${month2})`);
    const elems2 = await elem.select(month2);
    if (elems2.length !== 1) {
      throw new AppError(`failed to select month2 (elems2.length: ${elems2.length})`);
    }
    if (elems2[0] !== month2) {
      throw new AppError(`failed to select month2 (elems2[0]: ${elems2[0]})`);
    }
    await maEyesWaitLoading(page);
  }
}

async function puppeteerBrowserPage(
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
      // opts: ["--window-position=20,20", "--window-size=1400,800"],
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

async function puppeteerClose(browser: puppeteer.Browser, disconnect: boolean): Promise<void> {
  if (disconnect) {
    browser.disconnect();
  } else {
    browser.close();
  }
}

// @template:cookie
// web_cookie.md
async function puppeteerCookieLoad(page: puppeteer.Page, cookiePath: string): Promise<void> {
  if (!fs.existsSync(cookiePath)) {
    // TODO: catch ENOENT instead
    throw new AppError(`cookie file (${cookiePath}) not found`);
  }
  const txt = fs.readFileSync(cookiePath, "utf8");
  const cookies: puppeteer.Protocol.Network.CookieParam[] = JSON.parse(txt);
  for (const cookie of cookies) {
    logger.debug(`page.setCookie(): ${JSON.stringify(cookie)}`);
    // eslint-disable-next-line no-await-in-loop
    await page.setCookie(cookie);
  }
}

async function puppeteerCookieSave(page: puppeteer.Page, cookiePath: string): Promise<void> {
  logger.info("page.cookies()");
  const cookiesObject = await page.cookies();
  const s = JSON.stringify(cookiesObject, null, 2) + "\n";
  logger.info(`writeFile ${cookiePath}`);
  fs.writeFileSync(cookiePath, s);
}

async function $x(
  page: puppeteer.Page | puppeteer.ElementHandle<Element>,
  expression: string
): ReturnType<typeof page.$x> {
  // logger.debug(`$x(\`${expression}\`)`);
  return page.$x(expression);
}

async function $xn(
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
    throw new AppError(`BUG: '$x(\`${expression}\`').length is not ${n}, actually ${elementHandles.length}`);
  } else {
    throw new AppError(`BUG: ${errMsg}; $x(\`${expression}'\`.length is not ${n}, actually ${elementHandles.length}`);
  }
}

async function $x1(
  page: puppeteer.Page | puppeteer.ElementHandle<Element>,
  expression: string,
  errMsg: string
): Promise<puppeteer.ElementHandle<Node>> {
  return (await $xn(page, expression, 1, errMsg))[0];
}

class Queue<T> {
  private readonly q: T[];
  private readonly qWaiters: { resolve: (value: "resolved") => void }[];

  constructor() {
    this.q = [];
    this.qWaiters = [];
  }

  push(elem: T): number {
    const ret = this.q.unshift(elem); // XXX: slow; should be real queue
    this.qWaiters.shift()?.resolve("resolved"); // XXX: slow; should be real queue
    return ret;
  }

  async pop(): Promise<T> {
    const ret = this.q.pop();
    if (ret !== undefined) {
      return ret;
    }

    const p = new Promise((resolve) => {
      this.qWaiters.push({ resolve });
    });
    await p;
    const ret2 = this.q.pop();
    if (ret2 === undefined) unreachable();
    return ret2;
  }
}

function sleep(milliSeconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliSeconds));
}

function unreachable(): never {
  throw new AppError("BUG: unreachable", true);
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
// cli

export const VERSION = "2.1.0";

interface OptsGlobal {
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
  .addOption(new commander.Option("    --ignore-https", "HTTPSエラーを無視する").default(false))
  .addOption(new commander.Option("    --ma-pass <pass>", "MA-EYESのパスワード").env("KOUSU_MA_PASS").makeOptionMandatory(true))
  .addOption(new commander.Option("    --ma-url <url>", "MA-EYESログイン画面のURL").env("KOUSU_MA_URL").makeOptionMandatory(true))
  .addOption(new commander.Option("    --ma-user <user>", "MA-EYESのユーザー名").env("KOUSU_MA_USER").makeOptionMandatory(true))
  .addOption(new commander.Option("    --month <yyyy-mm>", "処理する月 (e.g. 2006-01)").env("KOUSU_MONTH").makeOptionMandatory(true).default(cliParseMonth(datePrevMonth(), null), datePrevMonth()).argParser(cliParseMonth))
  .addOption(new commander.Option("-q, --quiet", "quiet mode").default(false).conflicts("verbose"))
  .addOption(new commander.Option("-v, --verbose", "print verbose output; -vv to print debug output").default(0).argParser(cliIncreaseVerbosity).conflicts("quiet"))
  .addOption(new commander.Option("    --z-puppeteer-connect-url <url>").hideHelp().conflicts(["zPuppeteerLaunchHandleSigint", "zPuppeteerLaunchHeadless"]))
  .addOption(new commander.Option("    --z-puppeteer-cookie-load <path>").hideHelp().conflicts(["zPuppeteerCookieSave"]))
  .addOption(new commander.Option("    --z-puppeteer-cookie-save <path>").hideHelp().conflicts(["zPuppeteerCookieLoad"]))
  .addOption(new commander.Option(" --no-z-puppeteer-launch-handle-sigint").hideHelp().conflicts(["zPuppeteerConnectUrl"]))
  .addOption(new commander.Option("    --z-puppeteer-launch-headless").hideHelp().default(false).conflicts(["zPuppeteerConnectUrl"]))
  .alias(); // dummy

const cliCommandExitStatus = new Queue<number>();

function cliCommandInit(): OptsGlobal {
  if (program.opts().quiet === true) {
    logger.level = Logger.Level.Error;
  } else if (program.opts().verbose === 0) {
    logger.level = Logger.Level.Warn;
  } else if (program.opts().verbose === 1) {
    logger.level = Logger.Level.Info;
  } else if (program.opts().verbose >= 1) {
    logger.level = Logger.Level.Debug;
  }

  logger.debug(`${path.basename(__filename)} version ${VERSION} PID ${process.pid}`);
  logger.debug("opts: %O", process.argv);

  return program.opts();
}

/* eslint-disable @typescript-eslint/no-unused-vars */
function cliIncreaseVerbosity(value: string /* actually undefined */, previous: number): number {
  return previous + 1;
}

export async function cliMain(): Promise<never> {
  try {
    await program.parse(process.argv);
    const exitStatus = await cliCommandExitStatus.pop();
    process.exit(exitStatus);
  } catch (e) {
    if (e instanceof AppError) {
      // assert.ok(e.constructor.name === "AppError")
      process.exit(1);
    }
    logger.error(`unexpected error: ${e}`);
    throw e;
  }
  unreachable();
}

/* eslint-disable @typescript-eslint/no-unused-vars */
function cliParseMonth(value: string, previous: unknown): [number, number] {
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

// -----------------------------------------------------------------------------
// command - import-kinmu

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

// prettier-ignore
program
  .command("import-kinmu")
  .description("MA-EYESにログインして「勤務時間取込」「保存」を行う")
  .allowExcessArguments(false)
  .action(async (opts: {}) => {
    const optsGlobal = cliCommandInit();

    const [browser, page] = await puppeteerBrowserPage(
      optsGlobal.ignoreHttps,
      optsGlobal.zPuppeteerConnectUrl || null,
      optsGlobal.zPuppeteerLaunchHandleSigint,
      optsGlobal.zPuppeteerLaunchHeadless
    );

    await maEyesLogin(
      page,
      optsGlobal.maUrl,
      optsGlobal.maUser,
      optsGlobal.maPass,
      optsGlobal.zPuppeteerCookieLoad || null,
      optsGlobal.zPuppeteerCookieSave || null
    );
    if ("zPuppeteerCookieSave" in optsGlobal) {
      logger.info("cookie-save done;");
      await puppeteerClose(browser, optsGlobal.zPuppeteerConnectUrl !== undefined);
      logger.debug("bye");
      cliCommandExitStatus.push(0);
    }

    await maEyesSelectYearMonth(page, optsGlobal.month[0], optsGlobal.month[1]);

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
    const elemsCalendarDate = await page.$x(`//table[@class="ui-datepicker-calendar"]/tbody/tr/td`);
    for (let i = 0; i < elemsCalendarDate.length; i++) {
      // [XXX-$x-again]: We can't iterate over elemsCalendarDate:
      //   for (const [i, elem] of elemsCalendarDate.entries()) {
      //   since DOM is updated within the loop (just try it if you don't get it).
      const elemsCalendarDate2 = await page.$x(`//table[@class="ui-datepicker-calendar"]/tbody/tr/td`);
      const elemDate = elemsCalendarDate2[i];
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

    await puppeteerClose(browser, optsGlobal.zPuppeteerConnectUrl !== undefined);
    logger.debug("bye");
    cliCommandExitStatus.push(0);
  });

// -----------------------------------------------------------------------------
// command - get

// prettier-ignore
program
  .command("get")
  .description("MA-EYESにログインして工数実績を取得する")
  .allowExcessArguments(false)
  .addOption(new commander.Option("    --out-csv <path>").env("KOUSU_OUT_CSV").hideHelp().argParser(errorOutCsv))
  .addOption(new commander.Option("    --out-json <path>").env("KOUSU_OUT_JSON").hideHelp().argParser(errorOutJson))
  .argument("<file>", "JSONの出力パス")
  .action(async (file: string, opts: {}) => {
    const optsGlobal = cliCommandInit();

    const [browser, page] = await puppeteerBrowserPage(
      optsGlobal.ignoreHttps,
      optsGlobal.zPuppeteerConnectUrl || null,
      optsGlobal.zPuppeteerLaunchHandleSigint,
      optsGlobal.zPuppeteerLaunchHeadless
    );

    await maEyesLogin(
      page,
      optsGlobal.maUrl,
      optsGlobal.maUser,
      optsGlobal.maPass,
      optsGlobal.zPuppeteerCookieLoad || null,
      optsGlobal.zPuppeteerCookieSave || null
    );
    if ("zPuppeteerCookieSave" in optsGlobal) {
      logger.info("cookie-save done;");
      await puppeteerClose(browser, optsGlobal.zPuppeteerConnectUrl !== undefined);
      logger.debug("bye");
      cliCommandExitStatus.push(0);
    }

    await maEyesSelectYearMonth(page, optsGlobal.month[0], optsGlobal.month[1]);

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
      const elemsCalendarDate2 = await page.$x(`//table[@class="ui-datepicker-calendar"]/tbody/tr/td`);
      const elemDate = elemsCalendarDate2[i];
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
        const elem = await $x1(page, `//table[@id="workResultView:j_idt69"]`, "勤務時間表の形式が不正です");
        const html = await elem.evaluate((el) => (el as unknown as HTMLElement).outerHTML);
        const kinmus = parseWeekKinmu(html); // Object.assign(kinmu, parseWeekKinmu(html));
        return kinmus;
      })();

      const [jissekis, projects_] = await (async () => {
        const elem = await $x1(page, `//div[@id="workResultView:items"]`, "工数実績入力表の形式が不正です");
        const html = await elem.evaluate((el) => (el as unknown as HTMLElement).outerHTML);
        return parseWeekJisseki(html);
      })();

      if (kinmus.length !== 7) {
        logger.error(`勤務時間表の形式が不正です: kinmus.length (${kinmus.length}) !== 7`);
      }
      if (jissekis.length !== 7) {
        logger.error(`工数実績入力表の形式が不正です: jissekis.length (${jissekis.length}) !== 7`);
      }
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

    fs.writeFileSync(file, json);
    await puppeteerClose(browser, optsGlobal.zPuppeteerConnectUrl !== undefined);
    logger.debug("bye");
    cliCommandExitStatus.push(0);
  });

// 勤務表パース
function parseWeekKinmu(html: string): (Kinmu | null)[] {
  // TS2322
  // const x = (expression: string, node: any): ReturnType<typeof xpath.select> => {
  const x = (expression: string, node: any): xpath.SelectedValue[] => {
    // logger.debug(`xpath.select(\`${expression}\`)`);
    return xpath.select(expression, node);
  };

  const doc = new xmldom.DOMParser({
    errorHandler: () => {
      /* nop; just to suppress error logs */
    },
  }).parseFromString(html);

  const trs = x(`//tr`, doc);
  if (trs.length !== 6) {
    throw new AppError(
      `BUG: 勤務時間表の形式が不正です (expected 6 trs (date 出社 退社 翌日 休憩 休み), found ${trs.length} trs)`,
      true
    );
  }

  const datumDate: string[] = []; //                7/27(月) 7/28(火) 7/29(水) 7/30(木) 7/31(金) 8/1(土) 8/2(日)
  const datumBegin: (string | null)[] = []; //      null     null     null     null     null     00:00   00:00
  const datumEnd: (string | null)[] = []; //        null     null     null     null     null     00:00   00:00
  const datumYokujitsu: (boolean | null)[] = []; // null     null     null     null     null     false   false
  const datumKyukei: (string | null)[] = []; //     null     null     null     null     null     0.0     0.0
  const datumYasumi: (string | null)[] = []; //     null     null     null     null     null     全休    全休
  // -> [{"date":"8/1(土)", "begin":"09:00", "end":"17:30", "yokujitu":false, "kyukei": "0.0", "yasumi":""|"全休"|"午前"|"午後"}]

  const checkTds = (row: number, tds: xpath.SelectedValue[], text0: string) => {
    if (tds.length !== 8) {
      throw new AppError(
        `BUG: 勤務時間表の形式が不正です (expected 8 tds (header+月火水木金土日), found ${tds.length} tds)`,
        true
      );
    }
    // .data
    if ((tds[0] as Element).textContent !== text0) {
      throw new AppError(
        `BUG: 勤務時間表の${row}行1列が "${text0}" でありません (found: ${(tds[0] as Element).textContent})`,
        true
      );
    }
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
      if (txt === null) {
        throw new AppError(`BUG: 勤務時間表の${row}行${i}列(${kind})が不正です (textContent===null)`, true);
      }
      const match = txt.match(/(\d\d?)\/(\d\d?)\((月|火|水|木|金|土|日)\)/);
      if (match === null) {
        throw new AppError(`BUG: 勤務時間表の${row}行${i}列(${kind})が不正です: ${txt}`, true);
      }
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
      if (value === null) {
        throw new AppError(`BUG: 勤務時間表の${row}行${i}列(${kind})が不正です (value=null)`, true);
      }
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
      if (value === null) {
        throw new AppError(`BUG: 勤務時間表の${row}行${i}列(${kind})が不正です (value=null)`, true);
      }
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
      if (ariaChecked !== "true" && ariaChecked !== "false") {
        throw new AppError(`BUG: 勤務時間表の${row}行${i}列(${kind})が不正です (aria-checked=${ariaChecked})`, true);
      }
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
      if (value === null) {
        throw new AppError(`BUG: 勤務時間表の${row}行${i}列(${kind})が不正です (value=null)`, true);
      }
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
      if (text !== "&nbsp;" && text !== "全休" && text !== "午前" && text !== "午後") {
        throw new AppError(`BUG: 勤務時間表の${row}行${i}列(${kind})が不正です (selected option: ${text})`, true);
      }
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
    if (isNaN(parseFloat(datumKyukei[i] as string))) {
      throw new AppError(`BUG: 勤務時間表の形式が不正です (休憩: ${datumKyukei[i]})`, true);
    }
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

  const errMsg = "工数実績入力表の形式が不正です";

  // TS2322
  // const x = (expression: string, node: any): ReturnType<typeof xpath.select> => {
  const x = (expression: string, node: any): xpath.SelectedValue[] => {
    // logger.debug(`xpath.select(\`${expression}\`)`);
    return xpath.select(expression, node);
  };

  const x1 = (expression: string, node: any): ReturnType<typeof xpath.select1> => {
    logger.debug(`xpath.select1(\`${expression}\`)`);
    return xpath.select1(expression, node);
  };

  const assertText = (expression: string, node: any, data: string) => {
    const node2 = x1(expression, node);
    if (node2 === undefined) {
      throw new AppError(`${errMsg}: node.$x(\`${expression}\`) === undefined`);
    }
    // ReferenceError: Text is not defined
    // if (!(node2 instanceof Text)) {
    if (node2.constructor.name !== "Text") {
      throw new AppError(`${errMsg}: node.$x(\`${expression}\`): expected: Text, acutual: ${node2.constructor.name}`);
    }
    const node3 = node2 as Text;
    if (node3.data !== data) {
      throw new AppError(`${errMsg}: node.$x(\`${expression}\`).data: expected: ${data}, actual: ${node3.data}`);
    }
    logger.debug(`$x(\`${expression}\`) === "${data}", ok`);
  };

  const doc = new xmldom.DOMParser({
    errorHandler: () => {
      /* nop; just to suppress error logs */
    },
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
    if (isNaN(parseFloat(elem.textContent as string))) {
      throw new AppError(`${errMsg}: 作業時間: ${elem.textContent})`, true);
    }
    return parseFloat(elem.textContent as string);
  });
  const timesFumei = (x(`tr[3]/th/span[2]`, thead) as Element[]).map((elem) => {
    if (elem.textContent === "" || elem.textContent === "不明時間") {
      return null;
    }
    if (isNaN(parseFloat(elem.textContent as string))) {
      throw new AppError(`${errMsg}: 不明時間: ${elem.textContent})`, true);
    }
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
    if (var_.length !== 7) {
      logger.error(`${errMsg}: ${name}.length (${var_.length}) !== 7`);
    }
  }

  const projectIds = (x(`tr/td[4]/div/span`, tbody) as Element[]).map((elem) => elem.textContent as string);
  const projectNames = (x(`tr/td[5]/div/span`, tbody) as Element[]).map((elem) => elem.textContent as string);

  // const projects_text: Text[] = x('tr/td[7]', tbody);
  // 月 ... 日
  const parseJisseki = (s: string, trtd: string): number => {
    if (isNaN(parseFloat(s as string))) {
      throw new AppError(`${errMsg}: 作業時間: ${trtd}: ${s})`, true);
    }
    return parseFloat(s as string);
  };
  const jissekis0 = (x(`tr/td[7]`, tbody) as Element[]).map((elem) =>
    parseJisseki(elem.textContent as string, `tr/td[7]`)
  );
  const jissekis1 = (x(`tr/td[8]`, tbody) as Element[]).map((elem) =>
    parseJisseki(elem.textContent as string, `tr/td[8]`)
  );
  const jissekis2 = (x(`tr/td[9]`, tbody) as Element[]).map((elem) =>
    parseJisseki(elem.textContent as string, `tr/td[9]`)
  );
  const jissekis3 = (x(`tr/td[10]`, tbody) as Element[]).map((elem) =>
    parseJisseki(elem.textContent as string, `tr/td[10]`)
  );
  const jissekis4 = (x(`tr/td[11]`, tbody) as Element[]).map((elem) =>
    parseJisseki(elem.textContent as string, `tr/td[11]`)
  );
  const jissekis5 = (x(`tr/td[12]`, tbody) as Element[]).map((elem) =>
    parseJisseki(elem.textContent as string, `tr/td[12]`)
  );
  const jissekis6 = (x(`tr/td[13]`, tbody) as Element[]).map((elem) =>
    parseJisseki(elem.textContent as string, `tr/td[13]`)
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
    if (var_.length !== projectIds.length) {
      logger.error(`${errMsg}: ${name}.length (${var_.length}) !== projectIds.length (${projectIds.length})`);
    }
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

// prettier-ignore
program
  .command("put")
  .description("MA-EYESにログインして工数実績を入力する")
  .allowExcessArguments(false)
  .addOption(new commander.Option("    --in-csv <path>").env("KOUSU_IN_CSV").hideHelp().argParser(errorInCsv))
  .addOption(new commander.Option("    --in-json <path>").env("KOUSU_IN_JSON").hideHelp().argParser(errorInJson))
  .argument("<file>", "入力するJSONのパス")
  .action(async (file: string, opts: {}) => {
    const optsGlobal = cliCommandInit();

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
    const [browser, page] = await puppeteerBrowserPage(
      optsGlobal.ignoreHttps,
      optsGlobal.zPuppeteerConnectUrl || null,
      optsGlobal.zPuppeteerLaunchHandleSigint,
      optsGlobal.zPuppeteerLaunchHeadless
    );

    await maEyesLogin(
      page,
      optsGlobal.maUrl,
      optsGlobal.maUser,
      optsGlobal.maPass,
      optsGlobal.zPuppeteerCookieLoad || null,
      optsGlobal.zPuppeteerCookieSave || null
    );
    if ("zPuppeteerCookieSave" in optsGlobal) {
      logger.info("cookie-save done;");
      await puppeteerClose(browser, optsGlobal.zPuppeteerConnectUrl !== undefined);
      logger.debug("bye");
      cliCommandExitStatus.push(0);
    }

    await maEyesSelectYearMonth(page, optsGlobal.month[0], optsGlobal.month[1]);

    const elemsCalendarDate = await $x(page, `//table[@class="ui-datepicker-calendar"]/tbody/tr/td`);
    for (let i = 0; i < elemsCalendarDate.length; i++) {
      // click monday
      // see [XXX-$x-again]
      const elemsCalendarDate2 = await page.$x(`//table[@class="ui-datepicker-calendar"]/tbody/tr/td`);
      const elemDate = elemsCalendarDate2[i];
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
          "勤務時間表の形式が不正です"
        );
        return Promise.all(
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
            "工数実績入力表の形式が不正です"
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
                "工数実績入力表の形式が不正です"
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

    await puppeteerClose(browser, optsGlobal.zPuppeteerConnectUrl !== undefined);
    logger.debug("bye");
    cliCommandExitStatus.push(0);
  });
