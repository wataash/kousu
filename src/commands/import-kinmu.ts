// SPDX-License-Identifier: Apache-2.0

/* eslint-disable no-await-in-loop */

import { Command } from "@oclif/command";
import type * as puppeteer from "puppeteer";

import { KousuError } from "../common";
import * as ma from "../ma";
import * as utils from "../utils";
import { logger } from "../utils";

export default class MaKinmuImport extends Command {
  year!: number;

  month!: number;

  static description = "MA-EYESにログインして「勤務時間取込」「保存」を行う";

  static examples = undefined;

  static flags = {
    ...utils.oclifFlags,
    ...utils.oclifFlagsPuppeteer,
  };

  async run2(): Promise<never> {
    // hack: validate month.default value with month.parse() (see [XXX default])
    if (process.env.KOUSU_MONTH === undefined) {
      process.env.KOUSU_MONTH = utils.prevMonth();
    }
    const parseResult = this.parse(MaKinmuImport);
    const flgs = parseResult.flags;
    const year = this.year;
    const month = this.month;

    // [XXX:eslint-tuple]
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
    const elemsCalendarDate = await page.$x(
      `//table[@class="ui-datepicker-calendar"]/tbody/tr/td`
    );
    for (let i = 0; i < elemsCalendarDate.length; i++) {
      // [XXX-$x-again]: We can't iterate over elemsCalendarDate:
      //   for (const [i, elem] of elemsCalendarDate.entries()) {
      //   since DOM is updated within the loop (just try it if you don't get it).
      const elemsCalendarDate2 = await page.$x(
        `//table[@class="ui-datepicker-calendar"]/tbody/tr/td`
      );
      const elemDate = elemsCalendarDate2[i];
      const txt = await page.evaluate((el) => el.innerText, elemDate);
      if (txt === "\u00A0") {
        // nbsp
        continue;
      }
      if (i % 7 !== 0 && txt !== "1") {
        // not monday nor 1st
        continue;
      }
      logger.info(
        `click: ${txt}(${["月", "火", "水", "木", "金", "土", "日"][i % 7]})`
      );
      // await Promise.all([page.waitForNavigation(), elemDate.click()]); // halts
      await elemDate.click();
      await ma.waitLoading(page);

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
      await Promise.all([
        ma.waitLoading(page),
        page.click("#workResultView\\:j_idt52"),
      ]);

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
      await Promise.all([
        ma.waitLoading(page),
        page.click("#workResultView\\:j_idt50\\:saveButton"),
      ]);

      logger.debug("next");
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
