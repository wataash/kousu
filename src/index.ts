#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

// API
export type { Jisseki, Kinmu, Kousu, ProjectName } from "./cli";
export { VERSION } from "./cli";

import { cliMain } from "./cli";

if (require.main === module) {
  cliMain();
}
