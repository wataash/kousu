// SPDX-License-Identifier: Apache-2.0

/* eslint-disable no-await-in-loop */

import * as fs from "fs";

import * as oclifCommand from "@oclif/command";
import { Command } from "@oclif/command";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type * as oclifParser from "@oclif/parser";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type * as puppeteer from "puppeteer";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { Jisseki, Kinmu, Kousu, Kousu010, ProjectName } from "./get";
import { KousuError } from "../common";
import * as ma from "../ma";
import * as utils from "../utils";
import { logger } from "../utils";

export default class Get extends Command {
  year!: number;

  month!: number;

  static description = "MA-EYESにログインして工数実績を入力する";

  static examples = undefined;

  static args: oclifParser.args.Input = [
    { name: "file", description: "入力するJSONのパス", required: true },
  ];

  static flags = {
    ...utils.oclifFlags,
    ...utils.oclifFlagsPuppeteer,

    // hidden
    "in-csv": oclifCommand.flags.string({
      hidden: true,
      env: "KOUSU_IN_CSV",
    }),
    "in-json": oclifCommand.flags.string({
      hidden: true,
      env: "KOUSU_IN_JSON",
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
    if (flgs["in-json"] !== undefined) {
      throw new KousuError(
        "--in-json (KOUSU_IN_JSON) は 0.3.0 で削除され、非オプション引数になりました"
      );
    }

    let compat: "0.1.0" | null = null;

    const kousu: Kousu | Kousu010 = (() => {
      const j = JSON.parse(
        fs.readFileSync(parseResult.args.file).toString()
      ) as Kousu | Kousu010;
      const e = (msg: string) => {
        throw new KousuError(`invalid JSON: ${msg}`);
      };
      // TODO: more strict check with quicktype
      if (j.version === undefined) e(`"version" not defined, must be "0.3.0"`);
      if (j.version !== "0.1.0" && j.version !== "0.3.0")
        e(`"version" must be "0.3.0"`);
      if (j.version === "0.1.0") compat = "0.1.0";
      if (j.projects === undefined)
        e(
          `"projects" not defined, must be object ({"project": "projectName"})`
        );
      if (!utils.isObject(j.projects))
        e(`"projects" must be object ({"project": "projectName"})`);
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
    const tmp = await utils.puppeteerBrowserPage(flgs);
    const browser = tmp[0] as puppeteer.Browser;
    const page = tmp[1] as puppeteer.Page;

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

      let modified = false;
      for (const [iDate, date] of dates.entries()) {
        const jisseki = mapDateJisseki[date];
        if (jisseki === undefined) {
          logger.debug(`${date} not found in JSON; skip`);
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
          const timeJisseki = (() => {
            const tmp = jisseki.jisseki[project];
            if (tmp === undefined) {
              logger.warn(
                `project ${project} not found in 工数実績入力表; skip`
              );
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
            `//tbody[@id="workResultView:items_data"]/tr[${iProj + 1}]/td[${
              iDate + 7
            }]`,
            "工数実績入力表の形式が不正です"
          );
          // await elem.evaluate((el) => {
          //   (el as HTMLElement).innerText = "9.9";
          // });
          const txt = await elem.evaluate(
            (el) => (el as HTMLElement).innerText
          );
          if (txt === timeJisseki) {
            continue;
          }
          modified = true;
          logger.debug(
            `${date} ${project} ${kousu.projects[project]} ${timeJisseki}`
          );
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
      await Promise.all([
        ma.waitLoading(page),
        page.click("#workResultView\\:j_idt50\\:saveButton"),
      ]);
      "breakpoint".match(/breakpoint/);
    }

    logger.debug("bye");
    this.exit(0);
  }

  async run(): Promise<never> {
    await utils.run(this.run2.bind(this));
    // suppress: TS2534: A function returning 'never' cannot have a reachable end point.
    throw new KousuError("BUG: NOTREACHED", true);
  }
}
