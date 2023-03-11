#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

// API
export { Jisseki, Kinmu, Kousu, ProjectName, VERSION } from "./cli";

import { cliMain } from "./cli";

if (require.main === module) {
  cliMain();
}
