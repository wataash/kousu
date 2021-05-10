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
  pathCookieLoad?: string,
  pathCookieSave?: string
): Promise<void> {
  if (pathCookieLoad !== undefined) {
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

  await page.evaluate(() => {
    (document.getElementById("loginView:userCode:input") as any).value = "";
  });
  await page.evaluate(() => {
    (document.getElementById("loginView:password:input") as any).value = "";
  });
  await page.type("#loginView\\:userCode\\:input", user, {
    delay: 0.5,
  });
  await page.type("#loginView\\:password\\:input", pass, {
    delay: 0.5,
  });
  logger.debug('page.click("#loginView\\:j_idt32")');
  // TODO: --puppeteer-connect-url だと画面が小さくて別のボタンが押されるっぽい
  await Promise.all([
    page.waitForNavigation(),
    page.click("#loginView\\:j_idt32"),
  ]);
  if (pathCookieSave !== undefined) {
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
    //   <!--   ^^^^^^^^^^^^^^^^^^^^^^                                                                                                                                                                ^^^^^^^^^^^^^^ -->
    //   <img id="workResultView:j_idt58" src="/maeyes/javax.faces.resource/loading.gif.xhtml?ln=image" alt="">
    // </div>
    // <!-- 画面遷移時; loading GIF: appear -->
    // <div id="workResultView:j_idt50:j_idt51" class="ui-blockui-content ui-widget ui-widget-content ui-corner-all ui-helper-hidden ui-shadow"></div>
    // <div id="workResultView:j_idt57"         class="ui-blockui-content ui-widget ui-widget-content ui-corner-all ui-helper-hidden ui-shadow" style="left: 504.795px; top: 410.55px; z-index: 1256; display: block;">
    //   <!--   ^^^^^^^^^^^^^^^^^^^^^^                                                                                                                                                                ^^^^^^^^^^^^^^^ -->
    //   <img id="workResultView:j_idt58" src="/maeyes/javax.faces.resource/loading.gif.xhtml?ln=image" alt="">
    // </div>
    const blockuiContent = await page.$x(
      '//div[contains(@class, "ui-blockui-content")]'
    );
    if (blockuiContent.length !== 2) {
      logger.warn(
        `BUG: number of $x(\`//div[contains(@class, "ui-blockui-content")]\`): ${blockuiContent.length}`
      );
      logger.warn(`wait 5s and return`);
      await page.waitForTimeout(5000);
      return "error";
    }
    const blockuiContent0 = await page.evaluate(
      (el) => el.outerHTML,
      blockuiContent[0]
    ); // <div id="workResultView:j_idt50:j_idt51" class="ui-blockui-content ui-widget ui-widget-content ui-corner-all ui-helper-hidden ui-shadow"></div>
    const blockuiContent1 = await page.evaluate(
      (el) => el.outerHTML,
      blockuiContent[1]
    ); // <div id="workResultView:j_idt57" class="ui-blockui-content ui-widget ui-widget-content ui-corner-all ui-helper-hidden ui-shadow" style="left: 285.796px; top: 227.8px; z-index: 1007; display: block; opacity: 0.0103886;"><img id="workResultView:j_idt58" src="/maeyes/javax.faces.resource/loading.gif.xhtml?ln=image" alt=""></div>
    if (!blockuiContent0.includes("workResultView:j_idt50:j_idt51")) {
      logger.warn(
        `BUG: workResultView:j_idt50:j_idt51 not found; found instead: ${blockuiContent0}`
      );
      logger.warn(`wait 5s and return`);
      await page.waitForTimeout(5000);
      return "error";
    }
    if (!blockuiContent1.includes("workResultView:j_idt57")) {
      logger.warn(
        `BUG: workResultView:j_idt57 not found; found instead: ${blockuiContent1}`
      );
      logger.warn(`wait 5s and return`);
      await page.waitForTimeout(5000);
      return "error";
    }
    if (kind === "appear" && blockuiContent1.includes("display: block")) {
      // logger.debug("appears, return");
      return "success";
    }
    if (kind === "disappear" && !blockuiContent1.includes("display: block")) {
      // logger.debug("disappears, return");
      return "success";
    }
    // logger.debug(`wait ${waitMs}ms (timeout: ${(timeoutMs - waitMs * (i - (i % 10))) / 1000}s)`);
    await page.waitForTimeout(100);
  }
  logger.debug("timeout, return");
  return "timeout";
}

// ページ遷移は page.waitForNavigation() で拾えないので、読み込みGIFが現れて消え
// るのを検出することにする
// XXX: 30s はてきとう
export async function waitLoading(
  page: puppeteer.Page,
  waitGIFMs = 30_000
): Promise<void> {
  const resultAppaer = await waitLoadingGIF(page, "appear", waitGIFMs);
  if (resultAppaer === "timeout") {
    return;
  }
  await page.waitForTimeout(500); // XXX: 500ms はてきとう
  const resultDisappear = await waitLoadingGIF(page, "disappear", waitGIFMs);
  if (resultDisappear === "timeout") {
    return;
  }
  await page.waitForTimeout(500); // XXX: 500ms はてきとう
}

export async function selectYearMonth(
  page: puppeteer.Page,
  year: number,
  month: number
): Promise<void> {
  const msg = "カレンダーの形式が不正です";

  // select year
  {
    const year_ = year.toString();
    // <select class="ui-datepicker-year" data-handler="selectYear" data-event="change" aria-label="select year">
    const elem = await utils.$x1(
      page,
      '//select[@class="ui-datepicker-year"]',
      msg
    );
    logger.debug(`elem.select(${year_})`);
    const elems2 = await elem.select(year_);
    if (elems2.length !== 1) {
      throw new KousuError(
        `failed to select year (elems2.length: ${elems2.length})`
      );
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
    const elem = await utils.$x1(
      page,
      '//select[@class="ui-datepicker-month"]',
      msg
    );
    logger.debug(`elem.select(${month2})`);
    const elems2 = await elem.select(month2);
    if (elems2.length !== 1) {
      throw new KousuError(
        `failed to select month2 (elems2.length: ${elems2.length})`
      );
    }
    if (elems2[0] !== month2) {
      throw new KousuError(`failed to select month2 (elems2[0]: ${elems2[0]})`);
    }
    await waitLoading(page);
  }
}
