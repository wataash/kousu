// SPDX-License-Identifier: Apache-2.0

/* eslint-disable no-await-in-loop */

import * as fs from "fs";
import * as stringWidth from "string-width";

import * as oclifCommand from "@oclif/command";
import { Command } from "@oclif/command";
import * as jsdom from "jsdom";
import * as puppeteer from "puppeteer";
import * as xpath from "xpath";
import * as xmldom from "xmldom";

import { KousuError } from "../common";
import * as ma from "../ma";
import * as utils from "../utils";
import { logger } from "../utils";

export default class Get extends Command {
  year!: number;

  month!: number;

  static description = "MA-EYESにログインして工数実績を取得する";

  static examples = undefined;

  static flags = {
    ...utils.oclifFlags,
    ...utils.oclifFlagsPuppeteer,

    "out-csv": oclifCommand.flags.string({
      description:
        "csvの出力パス; 指定しなければ標準出力 (environment variable: KOUSU_OUT_CSV)",
      env: "KOUSU_OUT_CSV",
    }),
    "out-json": oclifCommand.flags.string({
      description:
        "jsonの出力パス; 指定しなければ標準出力 (environment variable: KOUSU_OUT_JSON)",
      env: "KOUSU_OUT_JSON",
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

    {
      date: "7/27(月)";
      begin: "15:04";
      end: "15:04";
      yokujitsu: false;
      kyukei: "0.0";
      yasumi: "";
      sagyou: "0.0";
      fumei: "0.0";
      jisseki: {
        proj1: "0.0";
      }
    }
    const kousus: (Kinmu & Jisseki)[] = [];

    const projects: { [projectId: string]: ProjectName } = {};

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
      // nbsp
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

      const kinmus = await (async () => {
        const elem = await utils.$x1(
          page,
          `//table[@id="workResultView:j_idt69"]`,
          "勤務時間表の形式が不正です"
        );
        const html = await elem.evaluate((body) => body.outerHTML);
        const kinmus = parseWeekKinmu(html); // Object.assign(kinmu, parseWeekKinmu(html));
        return kinmus;
      })();

      const [jissekis, projects_] = await (async () => {
        const elem = await utils.$x1(
          page,
          `//div[@id="workResultView:items"]`,
          "工数実績入力表の形式が不正です"
        );
        const html = await elem.evaluate((body) => body.outerHTML);
        const [jissekis, projects_] = parseWeekJisseki(html);
        return [jissekis, projects_];
      })();

      if (kinmus.length != 7) {
        logger.error(
          `勤務時間表の形式が不正です: kinmus.length (${kinmus.length}) != 7`
        );
      }
      if (jissekis.length != 7) {
        logger.error(
          `工数実績入力表の形式が不正です: jissekis.length (${jissekis.length}) != 7`
        );
      }
      // TODO: projects_ が全ての週で一致するか確認

      for (const [i, kinmu] of kinmus.entries()) {
        if (kinmu === null) {
          continue;
        }
        // TS7053: bug?
        // @ts-ignore
        kousus.push(Object.assign({}, kinmu, jissekis[i]));
      }
      Object.assign(projects, projects_);

      logger.debug("next");
    }

    // date,    begin, end,   yokujitsu, kyukei, yasumi, sagyou, fumei, "proj1 name", "proj2 name"
    // 1/1(金), 00:00, 00:00, false,     0,      全休,   0.0,    ?,     0.0,          0.0
    // 1/2(土), ...
    const csv: string = (() => {
      const projectIds = Object.keys(projects);
      const csvData: string[][] = [
        [
          "date",
          "begin",
          "end",
          "yokujitsu",
          "kyukei",
          "yasumi",
          "sagyou",
          "fumei",
          ...projectIds.map((projectId) => projects[projectId]),
        ].map((value) => `"${value.replace('"', '""')}"`),
      ];
      for (const kousu of kousus) {
        let row: string[] = [
          kousu.date,
          kousu.begin,
          kousu.end,
          kousu.yokujitsu.toString(),
          kousu.kyukei,
          kousu.yasumi,
          kousu.sagyou,
          kousu.fumei,
          ...projectIds.map((projectId) => kousu.jisseki[projectId]),
        ];
        row = row.map((value) => `"${value.replace('"', '""')}"`);
        csvData.push(row);
      }

      const maxWidths: number[] = [];
      for (const iCol of [...Array(csvData[0].length).keys()]) {
        const maxWidth = Math.max(
          ...csvData.map((row) => stringWidth(row[iCol]))
        );
        maxWidths.push(maxWidth);
      }

      let csv = "";
      for (const row of csvData) {
        for (const iCol of [...Array(row.length).keys()]) {
          const col = row[iCol];
          if (iCol === row.length - 1) {
            csv += `${col}\n`;
          } else {
            csv += col + ", " + " ".repeat(maxWidths[iCol] - stringWidth(col)); // 2 for comma and space
          }
        }
      }
      return csv;
    })();

    // {
    //   "version": "0.1.0",
    //   "projects": {
    //     "proj1": "proj1 name"
    //     "proj2": "proj2 name"
    //   },
    //   "jissekis": [
    //     {"date":"1/1(金)","begin":"00:00","end":"00:00","yokujitsu":false,"kyukei":"0","yasumi":"全休","sagyou":"0.0","fumei":"0.0","jisseki":{"proj1":"0.0","proj2":"0.0"}},
    //     {"date":"1/2(土)",...},
    //     ...
    //   ]
    // }
    // const json = `${JSON.stringify(kousus, null, 2)}\n`;
    const json = `{
  "version": "0.1.0",
  "projects": ${JSON.stringify(projects, null, 2)
    .split("\n")
    .map((row) => `  ${row}`)
    .join("\n")},
  "jissekis": [\n${kousus
    .map((kousu) => `    ${JSON.stringify(kousu)}`)
    .join(",\n")}
  ]
 }
 `;

    if (flgs["out-csv"] === undefined) {
      process.stdout.write(csv);
    } else {
      fs.writeFileSync(flgs["out-csv"], csv);
    }

    if (flgs["out-json"] === undefined) {
      process.stdout.write(json);
    } else {
      fs.writeFileSync(flgs["out-json"], json);
    }

    this.exit(0);
  }

  async run() /* : Promise<never> */ {
    await utils.run(this.run2.bind(this));
    // NOTREACHED
  }
}

// -----------------------------------------------------------------------------
// types

export type ProjectName = string;

export interface Kinmu {
  date: string; // "7/27(月)" "8/1(土)"
  begin: string; // "15:04"
  end: string; // "15:04"
  yokujitsu: boolean;
  kyukei: string; // "0.0"
  yasumi: "" | "全休" | "午前" | "午後";
}

export interface Jisseki {
  sagyou: string; // "0.0"
  fumei: string; // "0.0"; 前後の月は ""
  jisseki: {
    [projectId: string]: string; // "proj1": "0.0"
  };
}

export interface Kousu {
  version: string;
  projects: { [projectId: string]: ProjectName };
  jissekis: (Kinmu & Jisseki)[];
}

// -----------------------------------------------------------------------------
// 勤務表パース

// TODO: rewrite with xpath
export function parseWeekKinmu(html: string): (Kinmu | null)[] {
  const dom = new jsdom.JSDOM(html);
  const document = dom.window.document;

  const trs = document.querySelectorAll("tr");
  if (trs.length !== 6) {
    throw new KousuError(
      `BUG: 勤務時間表の形式が不正です (expected 6 trs (date 出社 退社 翌日 休憩 休み), found ${trs.length} trs)`,
      true
    );
  }

  const datum_date: string[] = []; //                7/27(月) 7/28(火) 7/29(水) 7/30(木) 7/31(金) 8/1(土) 8/2(日)
  const datum_begin: (string | null)[] = []; //      null     null     null     null     null     00:00   00:00
  const datum_end: (string | null)[] = []; //        null     null     null     null     null     00:00   00:00
  const datum_yokujitsu: (boolean | null)[] = []; // null     null     null     null     null     false   false
  const datum_kyukei: (string | null)[] = []; //     null     null     null     null     null     0.0     0.0
  const datum_yasumi: (string | null)[] = []; //     null     null     null     null     null     全休    全休
  // -> [{"date":"8/1(土)", "begin":"09:00", "end":"17:30", "yokujitu":false, "kyukei": "0.0", "yasumi":""|"全休"|"午前"|"午後"}]

  const check_tds = (
    row: number,
    tds: NodeListOf<HTMLElementTagNameMap["td"]>,
    text0: string
  ) => {
    if (tds.length !== 8) {
      throw new KousuError(
        `BUG: 勤務時間表の形式が不正です (expected 8 tds (header+月火水木金土日), found ${tds.length} tds)`,
        true
      );
    }
    if (tds[0].textContent !== text0) {
      throw new KousuError(
        `BUG: 勤務時間表の${row}行1列が "${text0}" でありません (found: ${tds[0].textContent})`,
        true
      );
    }
  };

  // trs[0]: datum_date
  {
    const row = 1;
    const kind = "日付";
    const tds = trs[0].querySelectorAll("td");
    // debug: tds[6].innerHTML
    check_tds(row, tds, "");
    for (let i = 1; i < tds.length; i++) {
      const txt = tds[i].textContent;
      if (txt === null) {
        throw new KousuError(
          `BUG: 勤務時間表の${row}行${i}列(${kind})が不正です (textContent===null)`,
          true
        );
      }
      const match = txt.match(/(\d\d?)\/(\d\d?)\((月|火|水|木|金|土|日)\)/);
      if (match === null) {
        throw new KousuError(
          `BUG: 勤務時間表の${row}行${i}列(${kind})が不正です: ${txt}`,
          true
        );
      }
      datum_date.push(match[0]);
    }
  }

  // trs[1]: datum_begin
  {
    const row = 2;
    const kind = "出社";
    const tds = trs[1].querySelectorAll("td");
    check_tds(row, tds, kind);
    for (let i = 1; i < tds.length; i++) {
      const input = tds[i].querySelector("input");
      if (input === null) {
        datum_begin.push(null);
        continue;
      }
      const value = input.getAttribute("value"); // "00:00"
      if (value === null) {
        throw new KousuError(
          `BUG: 勤務時間表の${row}行${i}列(${kind})が不正です (value=null)`,
          true
        );
      }
      datum_begin.push(value);
    }
  }

  // trs[2]: datum_end
  {
    const row = 3;
    const kind = "退社";
    const tds = trs[2].querySelectorAll("td");
    check_tds(row, tds, kind);
    for (let i = 1; i < tds.length; i++) {
      const input = tds[i].querySelector("input");
      if (input === null) {
        datum_end.push(null);
        continue;
      }
      const value = input.getAttribute("value"); // "00:00"
      if (value === null) {
        throw new KousuError(
          `BUG: 勤務時間表の${row}行${i}列(${kind})が不正です (value=null)`,
          true
        );
      }
      datum_end.push(value);
    }
  }

  // trs[3]: datum_yokujitsu
  {
    const row = 4;
    const kind = "翌日";
    const tds = trs[3].querySelectorAll("td");
    check_tds(row, tds, kind);
    for (let i = 1; i < tds.length; i++) {
      const input = tds[i].querySelector("input");
      if (input === null) {
        datum_yokujitsu.push(null);
        continue;
      }
      const aria_checked = input.getAttribute("aria-checked");
      if (aria_checked !== "true" && aria_checked !== "false") {
        throw new KousuError(
          `BUG: 勤務時間表の${row}行${i}列(${kind})が不正です (aria-checked=${aria_checked})`,
          true
        );
      }
      datum_yokujitsu.push(aria_checked === "true");
    }
  }

  // trs[4]: datum_kyukei
  {
    const row = 5;
    const kind = "休憩";
    const tds = trs[4].querySelectorAll("td");
    check_tds(row, tds, kind);
    for (let i = 1; i < tds.length; i++) {
      const input = tds[i].querySelector("input");
      if (input === null) {
        datum_kyukei.push(null);
        continue;
      }
      const value = input.getAttribute("value");
      if (value === null) {
        throw new KousuError(
          `BUG: 勤務時間表の${row}行${i}列(${kind})が不正です (value=null)`,
          true
        );
      }
      datum_kyukei.push(value);
    }
  }

  // trs[5]: datum_yasumi
  {
    const row = 6;
    const kind = "休み";
    const tds = trs[5].querySelectorAll("td");
    check_tds(row, tds, kind);
    for (let i = 1; i < tds.length; i++) {
      const option = tds[i].querySelector('option[selected="selected"]');
      if (option === null) {
        datum_yasumi.push(null);
        continue;
      }
      const text = option.textContent;
      if (
        text !== "" &&
        text !== "全休" &&
        text !== "午前" &&
        text !== "午後"
      ) {
        throw new KousuError(
          `BUG: 勤務時間表の${row}行${i}列(${kind})が不正です (selected option: ${text})`,
          true
        );
      }
      datum_yasumi.push(text);
    }
  }

  const ret: (Kinmu | null)[] = [];
  for (let i = 0; i < datum_date.length; i++) {
    if (
      datum_begin[i] === null ||
      datum_end[i] === null ||
      datum_yokujitsu[i] === null ||
      datum_kyukei[i] === null ||
      datum_yasumi[i] === null
    ) {
      ret.push(null);
      continue;
    }
    ret.push({
      date: datum_date[i],
      begin: datum_begin[i] as string,
      end: datum_end[i] as string,
      yokujitsu: datum_yokujitsu[i] as boolean,
      kyukei: datum_kyukei[i] as string,
      yasumi: datum_yasumi[i] as "" | "全休" | "午前" | "午後",
    });
  }

  return ret;
}

// -----------------------------------------------------------------------------
// 工数実績入力表パース

export function parseWeekJisseki(
  html: string
): [Jisseki[], { [projectId: string]: ProjectName }] {
  const jissekis: Jisseki[] = [];
  const projects: { [projectId: string]: ProjectName } = {};

  const errMsg = "工数実績入力表の形式が不正です";

  // TS2322
  // const x = (expression: string, node: any): ReturnType<typeof xpath.select> => {
  const x = (expression: string, node: any): xpath.SelectedValue[] => {
    logger.debug(`xpath.select(\`${expression}\`)`);
    return xpath.select(expression, node);
  };

  const x1 = (
    expression: string,
    node: any
  ): ReturnType<typeof xpath.select1> => {
    logger.debug(`xpath.select1(\`${expression}\`)`);
    return xpath.select1(expression, node);
  };

  const assertText = (expression: string, node: any, data: string) => {
    const node2 = x1(expression, node);
    if (node2 === undefined) {
      throw new KousuError(
        `${errMsg}: node.$x(\`${expression}\`) === undefined`
      );
    }
    // ReferenceError: Text is not defined
    // if (!(node2 instanceof Text)) {
    if (node2.constructor.name !== "Text") {
      throw new KousuError(
        `${errMsg}: node.$x(\`${expression}\`): expected: Text, acutual: ${node2.constructor.name}`
      );
    }
    const node3 = node2 as Text;
    if (node3.data !== data) {
      throw new KousuError(
        `${errMsg}: node.$x(\`${expression}\`).data: expected: ${data}, actual: ${node3.data}`
      );
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
  // const times_sagyou = (x(`tr[2]/th/span[2]`, thead) as Element[]).map((elem) => elem.textContent);

  const times_sagyou = (x(`tr[2]/th/span[2]`, thead) as Element[]).map(
    (elem) => elem.textContent
  ) as string[];
  const times_fumei = (x(`tr[3]/th/span[2]`, thead) as Element[]).map(
    (elem) => elem.textContent
  ) as string[];
  times_sagyou.shift();
  times_sagyou.shift();
  times_sagyou.shift();
  times_sagyou.shift();
  times_sagyou.shift(); // "作業時間"
  times_fumei.shift();
  times_fumei.shift();
  times_fumei.shift();
  times_fumei.shift();
  times_fumei.shift(); // "不明時間"

  const dates = (x(`tr[4]/th/span[2]`, thead) as Element[]).map(
    (elem) => elem.textContent as string
  );
  dates.shift();
  dates.shift();
  dates.shift(); // "項目No"
  dates.shift(); // "名称"
  dates.shift();
  // 7/27(月) 28(火) 29(水) 30(木) 31(金) 1(土) 2(日)
  // という形式で使いづらいので捨てる

  for (const [name, var_] of [
    ["times_sagyou", times_sagyou],
    ["times_fumei", times_fumei],
    ["dates", dates],
  ]) {
    if (var_.length != 7) {
      logger.error(`${errMsg}: ${name}.length (${var_.length}) != 7`);
    }
  }

  const project_ids = (x(`tr/td[4]/div/span`, tbody) as Element[]).map(
    (elem) => elem.textContent as string
  );
  const project_names = (x(`tr/td[5]/div/span`, tbody) as Element[]).map(
    (elem) => elem.textContent as string
  );

  // const projects_text: Text[] = x('tr/td[7]', tbody);
  // 月 ... 日
  const kousus0 = (x(`tr/td[7]`, tbody) as Element[]).map(
    (elem) => elem.textContent as string
  );
  const kousus1 = (x(`tr/td[8]`, tbody) as Element[]).map(
    (elem) => elem.textContent as string
  );
  const kousus2 = (x(`tr/td[9]`, tbody) as Element[]).map(
    (elem) => elem.textContent as string
  );
  const kousus3 = (x(`tr/td[10]`, tbody) as Element[]).map(
    (elem) => elem.textContent as string
  );
  const kousus4 = (x(`tr/td[11]`, tbody) as Element[]).map(
    (elem) => elem.textContent as string
  );
  const kousus5 = (x(`tr/td[12]`, tbody) as Element[]).map(
    (elem) => elem.textContent as string
  );
  const kousus6 = (x(`tr/td[13]`, tbody) as Element[]).map(
    (elem) => elem.textContent as string
  );

  logger.debug(`number of projects: ${project_ids.length}`);
  for (const [name, var_] of [
    ["project_names", project_names],
    ["kousus0", kousus0],
    ["kousus1", kousus1],
    ["kousus2", kousus2],
    ["kousus3", kousus3],
    ["kousus4", kousus4],
    ["kousus5", kousus5],
    ["kousus6", kousus6],
  ]) {
    if (var_.length != project_ids.length) {
      logger.error(
        `${errMsg}: ${name}.length (${var_.length}) != project_ids.length (${project_ids.length})`
      );
    }
  }

  jissekis.push({
    sagyou: times_sagyou[0],
    fumei: times_fumei[0],
    jisseki: {},
  });
  jissekis.push({
    sagyou: times_sagyou[1],
    fumei: times_fumei[1],
    jisseki: {},
  });
  jissekis.push({
    sagyou: times_sagyou[2],
    fumei: times_fumei[2],
    jisseki: {},
  });
  jissekis.push({
    sagyou: times_sagyou[3],
    fumei: times_fumei[3],
    jisseki: {},
  });
  jissekis.push({
    sagyou: times_sagyou[4],
    fumei: times_fumei[4],
    jisseki: {},
  });
  jissekis.push({
    sagyou: times_sagyou[5],
    fumei: times_fumei[5],
    jisseki: {},
  });
  jissekis.push({
    sagyou: times_sagyou[6],
    fumei: times_fumei[6],
    jisseki: {},
  });
  for (const [i, project_id] of project_ids.entries()) {
    projects[project_id] = project_names[i];
    jissekis[0].jisseki[project_id] = kousus0[i];
    jissekis[1].jisseki[project_id] = kousus1[i];
    jissekis[2].jisseki[project_id] = kousus2[i];
    jissekis[3].jisseki[project_id] = kousus3[i];
    jissekis[4].jisseki[project_id] = kousus4[i];
    jissekis[5].jisseki[project_id] = kousus5[i];
    jissekis[6].jisseki[project_id] = kousus6[i];
  }

  return [jissekis, projects];
}
