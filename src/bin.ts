#!/usr/bin/env node

/// CLI

import { doctor } from "./doctor.js";
import { watch } from "./watch.js";

const command = process.argv[2];

/// Main

function main() {
  switch (command) {
    case "doctor":
      return doctor();

    default:
    case "watch":
      return watch();
  }
}

main();
