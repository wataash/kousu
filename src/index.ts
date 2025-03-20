#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2021-2025 Wataru Ashihara <wataash0607@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// API
export type { Jisseki, Kinmu, Kousu, ProjectName } from "./cli";
export { VERSION } from "./cli";

import { cliMain } from "./cli";

if (require.main === module) {
  cliMain();
}
