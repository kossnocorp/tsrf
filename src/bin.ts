/// CLI

import { watch } from "./watch.js";
import { Utils } from "./utils.js";

const command = process.argv[2];

if (command !== "start" && command !== "init") {
}

/// Main

function main() {
  switch (command) {
    case "watch":
      return watch();

    default:
      Utils.error(`Unknown command ${command}`);
      process.exit(1);
  }
}

main();
