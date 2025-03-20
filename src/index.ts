#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2021-2025 Wataru Ashihara <wataash0607@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import esMain from "es-main";

// API
export type { Jisseki, Kinmu, Kousu, ProjectName } from "./cli.js";
export { VERSION } from "./cli.js";

import { cliMain } from "./cli.js";

if (esMain(import.meta) && !process.env.KOUSU_TEST) {
  await cliMain();
}
