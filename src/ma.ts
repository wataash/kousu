// SPDX-License-Identifier: Apache-2.0

/* eslint-disable no-await-in-loop */
/* eslint-disable no-warning-comments */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type * as puppeteer from "puppeteer";

import { KousuError } from "./common";
import * as utils from "./utils";
import { logger } from "./utils";

export async function login(
  page: puppeteer.Page,
  urlLogin: string,
  user: string,
  pass: string,
  pathCookieLoad: string | null,
  pathCookieSave: string | null
): Promise<void> {
  if (pathCookieLoad !== null) {
    await utils.puppeteerCookieLoad(page, pathCookieLoad);
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

  const inputUser = await utils.$x1(
    page,
    `//input[@data-p-label="ユーザコード"]`,
    "「ユーザーコード」のinput elementが見つかりません"
  );
  await page.evaluate((el, user) => (el.value = user), inputUser as unknown as HTMLInputElement, user);
  const inputPass = await utils.$x1(
    page,
    `//input[@data-p-label="パスワード"]`,
    "「パスワード」のinput elementが見つかりません"
  );
  await page.evaluate((el, pass) => (el.value = pass), inputPass as unknown as HTMLInputElement, pass);
  const button = await utils.$x1(page, `//div[@class="login-actions"]/button`, "「ログイン」ボタンが見つかりません");
  // XXX: 画面拡大率が100%でないと（主に --puppeteer-connect-url の場合）座標がずれて別のボタンが押される
  await Promise.all([page.waitForNavigation(), (button as unknown as HTMLButtonElement).click()]);
  if (pathCookieSave !== null) {
    await utils.puppeteerCookieSave(page, pathCookieSave);
  }
}

// return false if timeout
async function waitLoadingGIF(
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
      await utils.sleep(5000);
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
    await utils.sleep(100);
  }
  logger.debug("timeout, return");
  return "timeout";
}

// ページ遷移は page.waitForNavigation() で拾えないので、読み込みGIFが現れて消え
// るのを検出することにする
// XXX: 30s はてきとう
export async function waitLoading(page: puppeteer.Page, waitGIFMs = 30_000): Promise<void> {
  const resultAppaer = await waitLoadingGIF(page, "appear", waitGIFMs);
  if (resultAppaer === "timeout") {
    return;
  }
  await utils.sleep(500); // XXX: 500ms はてきとう
  const resultDisappear = await waitLoadingGIF(page, "disappear", waitGIFMs);
  if (resultDisappear === "timeout") {
    return;
  }
  await utils.sleep(500); // XXX: 500ms はてきとう
}

export async function selectYearMonth(page: puppeteer.Page, year: number, month: number): Promise<void> {
  const msg = "カレンダーの形式が不正です";

  // select year
  {
    const year_ = year.toString();
    // <select class="ui-datepicker-year" data-handler="selectYear" data-event="change" aria-label="select year">
    const elem = await utils.$x1(page, '//select[@class="ui-datepicker-year"]', msg);
    logger.debug(`elem.select(${year_})`);
    const elems2 = await elem.select(year_);
    if (elems2.length !== 1) {
      throw new KousuError(`failed to select year (elems2.length: ${elems2.length})`);
    }
    if (elems2[0] !== year_) {
      throw new KousuError(`failed to select year (elems2[0]: ${elems2[0]})`);
    }
    await waitLoading(page);
  }

  // select month
  {
    const month2 = (month - 1).toString();
    // <select class="ui-datepicker-month" data-handler="selectMonth" data-event="change" aria-label="select month">
    const elem = await utils.$x1(page, `//select[@class="ui-datepicker-month"]`, msg);
    logger.debug(`elem.select(${month2})`);
    const elems2 = await elem.select(month2);
    if (elems2.length !== 1) {
      throw new KousuError(`failed to select month2 (elems2.length: ${elems2.length})`);
    }
    if (elems2[0] !== month2) {
      throw new KousuError(`failed to select month2 (elems2[0]: ${elems2[0]})`);
    }
    await waitLoading(page);
  }
}
