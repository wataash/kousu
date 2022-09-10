#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

// API
export { Jisseki, Kinmu, Kousu, ProjectName } from "./command-get";

import { run } from "./cli";

if (require.main === module) {
  run();
}
