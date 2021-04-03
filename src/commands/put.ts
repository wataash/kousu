// SPDX-License-Identifier: Apache-2.0

/* eslint-disable no-await-in-loop */

import * as fs from "fs";

import * as oclifCommand from "@oclif/command";
import { Command } from "@oclif/command";

import type { Jisseki, Kinmu, Kousu, ProjectName } from "./get";
import { KousuError } from "../common";
import * as ma from "../ma";
import * as utils from "../utils";
import { logger } from "../utils";

export default class Get extends Command {
  year!: number;

  month!: number;

  static description = "MA-EYESにログインして工数実績を入力する";

  static examples = undefined;

  static flags = {
    ...utils.oclifFlags,
    ...utils.oclifFlagsPuppeteer,

    "in-json": oclifCommand.flags.string({
      description: "入力するjsonのパス (environment variable: KOUSU_IN_JSON)",
      required: true,
      exclusive: ["out-json"],
      env: "KOUSU_IN_JSON",
    }),

    // hidden
    "in-csv": oclifCommand.flags.string({
      hidden: true,
      env: "KOUSU_IN_CSV",
    }),
  };

  async run2(): Promise<never> {
    // hack: validate month.default value with month.parse() (see [XXX default])
    if (process.env.KOUSU_MONTH === undefined) {
      process.env.KOUSU_MONTH = utils.prevMonth();
    }
    const parseResult = this.parse(Get);
    const flgs = parseResult.flags;
    const year = this.year;
    const month = this.month;

    if (flgs["in-csv"] !== undefined) {
      throw new KousuError(
        "--in-csv (KOUSU_IN_CSV) は 0.2.0 で削除され、--in-json のみサポートになりました"
      );
    }

    const kousu: Kousu = (() => {
      const j = JSON.parse(
        fs.readFileSync(flgs["in-json"]).toString()
      ) as Kousu;
      if (j.version !== "0.1.0") {
        throw new KousuError(
          `invalid JSON: "version": expected "0.1.0", actual "${j.version}"`
        );
      }
      return j;
    })();

    const mapDateJisseki = kousu.jissekis.reduce((acc, jisseki) => {
      acc[jisseki.date] = jisseki;
      return acc;
    }, {} as { [date: string]: typeof kousu.jissekis[number] });

    const [browser, page] = await utils.puppeteerBrowserPage(flgs);

    await ma.login(
      page,
      flgs["ma-url"],
      flgs["ma-user"],
      flgs["ma-pass"],
      flgs["puppeteer-cookie-load"],
      flgs["puppeteer-cookie-save"]
    );
    if (parseResult.flags["puppeteer-cookie-save"] !== undefined) {
      logger.info("cookie-save done;");
      await browser.close();
      logger.debug("bye");
      this.exit(0);
    }

    await ma.selectYearMonth(page, year, month);

    const elemsCalendarDate = await utils.$x(
      page,
      `//table[@class="ui-datepicker-calendar"]/tbody/tr/td`
    );
    for (let i = 0; i < elemsCalendarDate.length; i++) {
      // click monday
      // see [XXX-$x-again]
      const elemsCalendarDate2 = await page.$x(
        `//table[@class="ui-datepicker-calendar"]/tbody/tr/td`
      );
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
      logger.info(
        `click: ${txt}(${["月", "火", "水", "木", "金", "土", "日"][i % 7]})`
      );
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
        return Promise.all(
          elems
            .slice(1)
            .map(async (elem) =>
              elem.evaluate((el) => (el as HTMLElement).innerText)
            )
        );
      })();

      for (const [iDate, date] of dates.entries()) {
        const jisseki = mapDateJisseki[date];
        if (jisseki === undefined) {
          logger.debug(`${date} not found in input CSV/JSON; skip`);
          continue;
        }
        // $x(`//tbody[@id="workResultView:items_data"]/tr/td[4]/text()`)
        const elemsProject = await utils.$x(
          page,
          `//tbody[@id="workResultView:items_data"]/tr/td[4]`
        );
        const projects = await Promise.all(
          elemsProject.map(async (elem) =>
            elem.evaluate((el) => (el as HTMLElement).innerText)
          )
        );
        for (const [iProj, project] of projects.entries()) {
          const timeJisseki = jisseki.jisseki[project];
          if (timeJisseki === undefined) {
            logger.warn(`project ${project} not found in 工数実績入力表; skip`);
            continue;
          }
          // $x(`//tbody[@id="workResultView:items_data"]/tr[1]/td[7]`)[0]
          const elem = await utils.$x1(
            page,
            `//tbody[@id="workResultView:items_data"]/tr[${iProj + 1}]/td[${
              iDate + 7
            }]`,
            "工数実績入力表の形式が不正です"
          );
          // await elem.evaluate((el) => {
          //   (el as HTMLElement).innerText = "9.9";
          // });
          await elem.click();
          await page.keyboard.type(timeJisseki);
          // loading GIFが出ないことがあるのでタイムアウトは短めにする
          // await Promise.all([ma.waitLoading(page, 300), page.keyboard.press("Tab")]);
          await Promise.all([
            ma.waitLoading(page, 300),
            page.keyboard.press("Tab"),
          ]);
          // TODO: 現在のvalueと比べて、変わっていなけば入力しない

          "breakpoint".match(/breakpoint/);
        }
        "breakpoint".match(/breakpoint/);
      }

      // 保存
      logger.debug("保存");
      await Promise.all([
        ma.waitLoading(page),
        page.click("#workResultView\\:j_idt50\\:saveButton"),
      ]);

      logger.debug("next");
    }

    logger.debug("bye");
    this.exit(0);
  }

  async run() /* : Promise<never> */ {
    await utils.run(this.run2.bind(this));
    // NOTREACHED
  }
}
