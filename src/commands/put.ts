// SPDX-License-Identifier: Apache-2.0

/* eslint-disable no-await-in-loop */

import * as fs from "node:fs";

import type * as puppeteer from "puppeteer";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { Jisseki, Kinmu, Kousu, Kousu010, ProjectName } from "./get";
import { KousuError } from "../common";
import { Args, ArgsPut } from "../index";
import * as ma from "../ma";
import * as utils from "../utils";
import { logger } from "../utils";

export async function run(args: Args, argsPut: ArgsPut): Promise<number> {
  let compat: "0.1.0" | null = null;

  const kousu: Kousu | Kousu010 = (() => {
    const j = JSON.parse(fs.readFileSync(argsPut.file, "utf8")) as Kousu | Kousu010;
    const e = (msg: string) => {
      throw new KousuError(`invalid JSON: ${msg}`);
    };
    // eslint-disable-next-line no-warning-comments
    // TODO: more strict check with quicktype
    if (j.version === undefined) e(`"version" not defined, must be "0.3.0"`);
    if (j.version !== "0.1.0" && j.version !== "0.3.0") e(`"version" must be "0.3.0"`);
    if (j.version === "0.1.0") compat = "0.1.0";
    if (j.projects === undefined) e(`"projects" not defined, must be object ({"project": "projectName"})`);
    if (!utils.isObject(j.projects)) e(`"projects" must be object ({"project": "projectName"})`);
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
  // [XXX:typescript-eslint#2098]
  const tmp = await utils.puppeteerBrowserPage(
    args.ignoreHttps,
    args.zPuppeteerConnectUrl || null,
    args.zPuppeteerLaunchHandleSigint,
    args.zPuppeteerLaunchHeadless
  );
  const browser = tmp[0] as puppeteer.Browser;
  const page = tmp[1] as puppeteer.Page;

  await ma.login(page, args.maUrl, args.maUser, args.maPass, args.zPuppeteerCookieLoad, args.zPuppeteerCookieSave);
  if ("zPuppeteerCookieSave" in args) {
    logger.info("cookie-save done;");
    await utils.puppeteerClose(browser, args.zPuppeteerConnectUrl !== undefined);
    logger.debug("bye");
    return 0;
  }

  await ma.selectYearMonth(page, args.month[0], args.month[1]);

  const elemsCalendarDate = await utils.$x(page, `//table[@class="ui-datepicker-calendar"]/tbody/tr/td`);
  for (let i = 0; i < elemsCalendarDate.length; i++) {
    // click monday
    // see [XXX-$x-again]
    const elemsCalendarDate2 = await page.$x(`//table[@class="ui-datepicker-calendar"]/tbody/tr/td`);
    const elemDate = elemsCalendarDate2[i];
    const txt = await page.evaluate((el) => el.innerText, elemDate);
    // nbsp; 前後の月
    if (txt === "\u00A0") {
      continue;
    }
    if (i % 7 !== 0 && txt !== "1") {
      // not monday nor 1st
      continue;
    }
    logger.info(`click: ${txt}(${["月", "火", "水", "木", "金", "土", "日"][i % 7]})`);
    await Promise.all([ma.waitLoading(page), elemDate.click()]);

    // (null | string)[7]
    // ["10/28(月)", ... "11/1(金)", "11/2(土)", "11/3(日)"]
    const dates = await (async () => {
      // $x(`//table[@id="workResultView:j_idt69"]//tr[1]/td`)
      const elems = await utils.$xn(
        page,
        `//table[@id="workResultView:j_idt69"]//tr[1]/td`,
        8,
        "勤務時間表の形式が不正です"
      );
      return Promise.all(elems.slice(1).map(async (elem) => elem.evaluate((el) => (el as HTMLElement).innerText)));
    })();

    let modified = false;
    for (const [iDate, date] of dates.entries()) {
      const jisseki = mapDateJisseki[date];
      if (jisseki === undefined) {
        logger.debug(`${date} not found in JSON; skip`);
        continue;
      }
      // $x(`//tbody[@id="workResultView:items_data"]/tr/td[4]/text()`)
      const elemsProject = await utils.$x(page, `//tbody[@id="workResultView:items_data"]/tr/td[4]`);
      const projects = await Promise.all(
        elemsProject.map(async (elem) => elem.evaluate((el) => (el as HTMLElement).innerText))
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
              throw new KousuError(`BUG: jisseki.jisseki[project]: ${tmp}`);
            }
            return tmp;
          }
          return tmp.toFixed(1);
        })();
        if (timeJisseki === null) {
          continue;
        }
        // $x(`//tbody[@id="workResultView:items_data"]/tr[1]/td[7]`)[0]
        const elem = await utils.$x1(
          page,
          `//tbody[@id="workResultView:items_data"]/tr[${iProj + 1}]/td[${iDate + 7}]`,
          "工数実績入力表の形式が不正です"
        );
        // await elem.evaluate((el) => {
        //   (el as HTMLElement).innerText = "9.9";
        // });
        const txt = await elem.evaluate((el) => (el as HTMLElement).innerText);
        if (txt === timeJisseki) {
          continue;
        }
        modified = true;
        logger.debug(`${date} ${project} ${kousu.projects[project]} ${timeJisseki}`);
        await elem.click();
        await page.keyboard.type(timeJisseki);
        // 値の確定・送信
        // $x(`//table[@id="workResultView:j_idt69"]//tr[1]/td[1]`)
        await Promise.all([
          ma.waitLoading(page),
          (
            await utils.$x1(
              page,
              `//table[@id="workResultView:j_idt69"]//tr[1]/td[1]`,
              "工数実績入力表の形式が不正です"
            )
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
    await Promise.all([ma.waitLoading(page), page.click("#workResultView\\:j_idt50\\:saveButton")]);
    "breakpoint".match(/breakpoint/);
  }

  await utils.puppeteerClose(browser, args.zPuppeteerConnectUrl !== undefined);
  logger.debug("bye");
  return 0;
}
