import { readFile } from "fs/promises";
import { TSConfig } from "./tsconfig.js";

export namespace Config {
  /// Types

  export interface Config {
    namespace?: string;
    tsconfig?: TSConfig.TSConfig;
  }

  /// Functions

  let cachedConfig: Config | undefined;

  export async function getConfig(): Promise<Config> {
    if (cachedConfig) return cachedConfig;

    cachedConfig = (await readFile("tsrfconfig.json", "utf-8")
      .then((content) => JSON.parse(content))
      .catch(() => ({}))) as Config;

    return cachedConfig;
  }
}
