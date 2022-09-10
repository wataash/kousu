// SPDX-License-Identifier: Apache-2.0

/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-warning-comments */

import * as fs from "node:fs";

import * as xpath from "xpath";
import * as xmldom from "@xmldom/xmldom";

import type { Args, ArgsGet } from "./cli";
import { KousuError } from "./common";
import * as ma from "./ma";
import * as utils from "./utils";
import { logger } from "./utils";

export async function run(args: Args, argsGet: ArgsGet): Promise<number> {
  const [browser, page] = await utils.puppeteerBrowserPage(
    args.ignoreHttps,
    args.zPuppeteerConnectUrl || null,
    args.zPuppeteerLaunchHandleSigint,
    args.zPuppeteerLaunchHeadless
  );

  await ma.login(
    page,
    args.maUrl,
    args.maUser,
    args.maPass,
    args.zPuppeteerCookieLoad || null,
    args.zPuppeteerCookieSave || null
  );
  if ("zPuppeteerCookieSave" in args) {
    logger.info("cookie-save done;");
    await utils.puppeteerClose(browser, args.zPuppeteerConnectUrl !== undefined);
    logger.debug("bye");
    return 0;
  }

  await ma.selectYearMonth(page, args.month[0], args.month[1]);

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

  const elemsCalendarDate = await utils.$x(page, `//table[@class="ui-datepicker-calendar"]/tbody/tr/td`);
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
    await Promise.all([ma.waitLoading(page), (elemDate as unknown as HTMLElement).click()]);

    const kinmus = await (async () => {
      const elem = await utils.$x1(page, `//table[@id="workResultView:j_idt69"]`, "勤務時間表の形式が不正です");
      const html = await elem.evaluate((el) => (el as unknown as HTMLElement).outerHTML);
      const kinmus = parseWeekKinmu(html); // Object.assign(kinmu, parseWeekKinmu(html));
      return kinmus;
    })();

    const [jissekis, projects_] = await (async () => {
      const elem = await utils.$x1(page, `//div[@id="workResultView:items"]`, "工数実績入力表の形式が不正です");
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

  fs.writeFileSync(argsGet.file, json);
  await utils.puppeteerClose(browser, args.zPuppeteerConnectUrl !== undefined);
  logger.debug("bye");
  return 0;
}

// -----------------------------------------------------------------------------
// types

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

export interface Kinmu010 {
  date: string; // "7/27(月)" "8/1(土)"
  begin: string; // "09:00"
  end: string; // "17:30"
  yokujitsu: boolean;
  kyukei: string; // "0.0"
  yasumi: "" | "全休" | "午前" | "午後";
}

export interface Jisseki010 {
  sagyou: string; // "0.0"
  fumei: string; // "0.0"; 前後の月は ""
  jisseki: {
    [projectId: string]: string; // "proj1": "0.0"
  };
}

export interface Kousu010 {
  version: string;
  projects: { [projectId: string]: ProjectName };
  jissekis: (Kinmu010 & Jisseki010)[];
}

// -----------------------------------------------------------------------------
// 勤務表パース

export function parseWeekKinmu(html: string): (Kinmu | null)[] {
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
    throw new KousuError(
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
      throw new KousuError(
        `BUG: 勤務時間表の形式が不正です (expected 8 tds (header+月火水木金土日), found ${tds.length} tds)`,
        true
      );
    }
    // .data
    if ((tds[0] as Element).textContent !== text0) {
      throw new KousuError(
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
        throw new KousuError(`BUG: 勤務時間表の${row}行${i}列(${kind})が不正です (textContent===null)`, true);
      }
      const match = txt.match(/(\d\d?)\/(\d\d?)\((月|火|水|木|金|土|日)\)/);
      if (match === null) {
        throw new KousuError(`BUG: 勤務時間表の${row}行${i}列(${kind})が不正です: ${txt}`, true);
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
        throw new KousuError(`BUG: 勤務時間表の${row}行${i}列(${kind})が不正です (value=null)`, true);
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
        throw new KousuError(`BUG: 勤務時間表の${row}行${i}列(${kind})が不正です (value=null)`, true);
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
        throw new KousuError(`BUG: 勤務時間表の${row}行${i}列(${kind})が不正です (aria-checked=${ariaChecked})`, true);
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
        throw new KousuError(`BUG: 勤務時間表の${row}行${i}列(${kind})が不正です (value=null)`, true);
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
        throw new KousuError(`BUG: 勤務時間表の${row}行${i}列(${kind})が不正です (selected option: ${text})`, true);
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
      throw new KousuError(`BUG: 勤務時間表の形式が不正です (休憩: ${datumKyukei[i]})`, true);
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

// -----------------------------------------------------------------------------
// 工数実績入力表パース

export function parseWeekJisseki(html: string): [Jisseki[], { [projectId: string]: ProjectName }] {
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
      throw new KousuError(`${errMsg}: node.$x(\`${expression}\`) === undefined`);
    }
    // ReferenceError: Text is not defined
    // if (!(node2 instanceof Text)) {
    if (node2.constructor.name !== "Text") {
      throw new KousuError(`${errMsg}: node.$x(\`${expression}\`): expected: Text, acutual: ${node2.constructor.name}`);
    }
    const node3 = node2 as Text;
    if (node3.data !== data) {
      throw new KousuError(`${errMsg}: node.$x(\`${expression}\`).data: expected: ${data}, actual: ${node3.data}`);
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
      throw new KousuError(`${errMsg}: 作業時間: ${elem.textContent})`, true);
    }
    return parseFloat(elem.textContent as string);
  });
  const timesFumei = (x(`tr[3]/th/span[2]`, thead) as Element[]).map((elem) => {
    if (elem.textContent === "" || elem.textContent === "不明時間") {
      return null;
    }
    if (isNaN(parseFloat(elem.textContent as string))) {
      throw new KousuError(`${errMsg}: 不明時間: ${elem.textContent})`, true);
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
      throw new KousuError(`${errMsg}: 作業時間: ${trtd}: ${s})`, true);
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
