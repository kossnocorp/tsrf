/// CLI

import { watch } from "./watch.js";

const command = process.argv[2];

/// Main

function main() {
  switch (command) {
    default:
    case "watch":
      return watch();
  }
}

main();
