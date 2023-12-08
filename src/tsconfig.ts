import { OpaqueString } from "typeroo/string/index.js";
import { Workspaces } from "./workspaces.js";
import { relative, resolve } from "path";
import { readFile, writeFile } from "fs/promises";
import { Utils } from "./utils.js";
import { format } from "prettier";
import { glob } from "glob";
import picocolors from "picocolors";
import { State } from "./state.js";

const { red, yellow, green, gray, blue } = picocolors;

export namespace TSConfig {
  /// Types

  export interface TSConfig {
    compilerOptions?: {
      composite?: boolean;
      paths?: TSConfigAliases;
      outDir?: string;
      tsBuildInfoFile?: string | undefined;
      skipLibCheck?: boolean;
      jsx?: "preserve" | undefined;
    };
    files?: string[];
    include?: string[] | undefined;
    exclude?: string[] | undefined;
    references?: TSConfigReference[];
  }

  export type TSConfigAliases = Record<TSConfigAlias, [TSConfigAliasResolve]>;

  export interface TSConfigReference {
    path: TSConfigReferencePath;
  }

  export type TSConfigAlias = OpaqueString<typeof tsConfigPathAliasBrand>;
  declare const tsConfigPathAliasBrand: unique symbol;

  export type TSConfigReferencePath = OpaqueString<
    typeof tsConfigReferencePathBrand
  >;
  declare const tsConfigReferencePathBrand: unique symbol;

  export type TSConfigAliasResolve = OpaqueString<
    typeof tsConfigPathResolveBrand
  >;
  declare const tsConfigPathResolveBrand: unique symbol;

  export type TSConfigPath = OpaqueString<typeof tsConfigPathBrand>;
  declare const tsConfigPathBrand: unique symbol;

  /// Functions

  function aliasFromWorkspaceName(workspaceName: Workspaces.WorkspaceName) {
    return workspaceName as unknown as TSConfigAlias;
  }

  function findRedundantAliases(
    aliases: TSConfigAliases,
    referencePath: TSConfigReferencePath
  ) {
    return Object.entries(aliases).find(([_, paths]) =>
      paths.includes(referencePath as unknown as TSConfigAliasResolve)
    )?.[0] as TSConfigAlias | undefined;
  }

  function referencePathToAliasResolve(referencePath: TSConfigReferencePath) {
    return referencePath as unknown as TSConfigAliasResolve;
  }

  function referencePathToAliashResolveGlob(
    referencePath: TSConfigReferencePath
  ) {
    return (referencePath + "/*") as TSConfigAliasResolve;
  }

  function pathAliasToGlob(pathAlias: TSConfigAlias) {
    return (pathAlias + "/*") as TSConfigAlias;
  }

  function referencesFromWorkspaceNames(
    workspacePath: Workspaces.WorkspacePath,
    dependencies: Workspaces.WorkspaceName[]
  ): TSConfigReference[] {
    return dependencies.map((dependencyName) => ({
      path: getReferencePath(
        Workspaces.getWorkspacePath(dependencyName),
        workspacePath
      ),
    }));
  }

  function referencesFromWorkspacePaths(
    workspacePaths: Set<Workspaces.WorkspacePath>
  ): TSConfigReference[] {
    return Array.from(workspacePaths).map((workspacePath) => ({
      path: getReferencePath(workspacePath),
    }));
  }

  function getReferencePath(
    dependencyPath: Workspaces.WorkspacePath,
    workspacePath?: Workspaces.WorkspacePath
  ) {
    return relative(
      workspacePath || State.root,
      dependencyPath
    ) as TSConfigReferencePath;
  }

  async function readTSConfig(path: TSConfigPath) {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content) as TSConfig;
  }

  function areReferencesEqual(a: TSConfigReference[], b: TSConfigReference[]) {
    return Utils.areEqual(a.map(pathFromReference), b.map(pathFromReference));
  }

  function pathFromReference(reference: TSConfigReference) {
    return reference.path;
  }

  async function mutateTSConfig(
    tsConfigPath: TSConfigPath,
    mutator: (
      tsConfig: TSConfig,
      readFromDisk: boolean
    ) => Utils.MaybePromise<Utils.MaybeArray<boolean | void>>,
    getDefault?: () => Utils.MaybePromise<TSConfig | undefined>
  ) {
    const [tsConfig, readFromDisk] = await readTSConfig(tsConfigPath)
      .then((config) => [config, true] as const)
      .catch(async (err) => {
        if (getDefault) return [await getDefault(), false] as const;
        Utils.error(`Error reading the ${tsConfigPath}`);
        Utils.log(new Error().stack);
        process.exit(1);
      });
    if (!tsConfig) return;

    const mutatorResult = await mutator(tsConfig, readFromDisk);

    const skipWrite = Array.isArray(mutatorResult)
      ? mutatorResult.every((result) => result === false)
      : mutatorResult === false;
    if (skipWrite) return;

    const content = await format(JSON.stringify(tsConfig), { parser: "json" });
    await writeFile(tsConfigPath, content);
  }

  function getTSConfigPath(workspace?: Workspaces.WorkspacePath) {
    return relative(
      State.root,
      resolve(workspace || "./", "tsconfig.json")
    ) as TSConfigPath;
  }

  function mutateConfigureWorkspaceTSConfig(
    tsConfig: TSConfig,
    jsx: boolean,
    force: boolean
  ) {
    if (
      !force &&
      tsConfig.compilerOptions &&
      tsConfig.compilerOptions.composite === true &&
      tsConfig.compilerOptions.outDir === ".ts"
    )
      return false;

    tsConfig.compilerOptions = tsConfig.compilerOptions || {};
    Object.assign(
      tsConfig.compilerOptions,
      defaultTSConfig(jsx).compilerOptions
    );
  }

  const defaultRootTSConfig: TSConfig = {
    files: [],
    include: undefined,
    exclude: undefined,
  };

  function defaultTSConfig(jsx: boolean) {
    const config: TSConfig = {
      include: ["**/*.ts"],
      compilerOptions: {
        composite: true,
        outDir: ".ts",
        skipLibCheck: true,
        tsBuildInfoFile: undefined,
      },
    } satisfies TSConfig;

    if (jsx) {
      config.compilerOptions!.jsx = "preserve";
      config.include!.push("react");
    }

    return config;
  }

  export function bootstrapWorkspaceTSConfigs(
    workspacePaths: Set<Workspaces.WorkspacePath>
  ) {
    return Promise.all(
      Array.from(workspacePaths).map(bootstrapWorkspaceTSConfig)
    );
  }

  async function bootstrapWorkspaceTSConfig(
    workspacePath: Workspaces.WorkspacePath
  ) {
    // Detect if the workspace has ts/tsx files
    const workspaceFiles = await glob(resolve(workspacePath, "**/*.{ts,tsx}"), {
      ignore: ["node_modules", ".ts"],
    });
    const workspaceHasJSX = workspaceFiles.some((file) =>
      file.endsWith(".tsx")
    );

    return mutateTSConfig(
      getTSConfigPath(workspacePath),
      (tsConfig, readFromDisk) => {
        const result = mutateConfigureWorkspaceTSConfig(
          tsConfig,
          workspaceHasJSX,
          !readFromDisk
        );
        if (result !== false)
          Utils.log(
            `Configured ${green(
              Workspaces.getWorkspaceName(workspacePath)
            )} tsconfig.json`
          );
        return result;
      },
      () => defaultTSConfig(workspaceHasJSX)
    );
  }

  export function bootstrapRootTSConfig(
    workspacePaths: Set<Workspaces.WorkspacePath>
  ) {
    return mutateTSConfig(
      getTSConfigPath(),
      (tsConfig) => {
        const prevTSConfig = Utils.cloneDeepJSON(tsConfig);

        delete tsConfig.include;
        delete tsConfig.exclude;
        tsConfig.files = [];
        tsConfig.references = referencesFromWorkspacePaths(workspacePaths);

        if (Utils.deepEqualJSON(tsConfig, prevTSConfig)) return false;
        Utils.log("Configured the root tsconfig.json");
      },
      () => Utils.cloneDeepJSON(defaultRootTSConfig)
    );
  }

  export function refreshTSConfigReferencesWorkspaceRename(
    workspacePath: Workspaces.WorkspacePath
  ) {
    // Use the existing references to get the up-to-date names
    return mutateTSConfig(getTSConfigPath(workspacePath), (tsConfig) => [
      // TODO: Figure out how to better support this
      // mutateConfigureWorkspaceTSConfig(tsConfig),
      tsConfig.references
        ? mutateUpdateReferences(tsConfig, tsConfig.references, workspacePath)
        : false,
    ]);
  }

  export function updateTSConfigReferences(
    workspacePath: Workspaces.WorkspacePath,
    deps: Workspaces.WorkspaceName[]
  ) {
    return mutateTSConfig(getTSConfigPath(workspacePath), (tsConfig) => {
      const references = referencesFromWorkspaceNames(workspacePath, deps);
      return [
        // TODO: Figure out how to efficiently track of the JSX support
        // mutateConfigureWorkspaceTSConfig(tsConfig),
        mutateUpdateReferences(tsConfig, references, workspacePath),
      ];
    });
  }

  function mutateUpdateReferences(
    tsConfig: TSConfig,
    references: TSConfigReference[],
    workspacePath: Workspaces.WorkspacePath
  ) {
    const prevTSConfig = Utils.cloneDeepJSON(tsConfig);
    const tsConfigReferences = tsConfig?.references || [];

    Utils.debug("References update!");
    Utils.debug("Actual references:", tsConfigReferences);
    Utils.debug("The tsconfig.tsbuildinfo references:", references);

    tsConfig.references = references;

    const redundantRefs = Utils.getRedundantItems(
      tsConfigReferences,
      references
    );
    const missingRefs = Utils.getMissingItems(tsConfigReferences, references);

    mutateRemoveRedundantAliases(tsConfig, redundantRefs);
    mutateAddMissingAliases(tsConfig, missingRefs, workspacePath);

    if (Utils.deepEqualJSON(prevTSConfig, tsConfig)) return false;

    Utils.log(
      `Writing ${green(
        Workspaces.getWorkspaceName(workspacePath)
      )} tsconfig.json with updated references list`
    );
    Utils.debug("References:", references);
  }

  function mutateRemoveRedundantAliases(
    tsConfig: TSConfig,
    redundantRefs: TSConfigReference[]
  ) {
    tsConfig.compilerOptions = tsConfig.compilerOptions || {};
    tsConfig.compilerOptions.paths = tsConfig.compilerOptions.paths || {};

    for (const { path: referencePath } of redundantRefs) {
      const pathAlias = findRedundantAliases(
        tsConfig.compilerOptions.paths,
        referencePath
      );
      if (pathAlias) {
        delete tsConfig.compilerOptions.paths[pathAlias];
        delete tsConfig.compilerOptions.paths[pathAliasToGlob(pathAlias)];
      }
    }
  }

  function mutateAddMissingAliases(
    tsConfig: TSConfig,
    missingRefs: TSConfigReference[],
    workspacePath: Workspaces.WorkspacePath
  ) {
    tsConfig.compilerOptions = tsConfig.compilerOptions || {};
    tsConfig.compilerOptions.paths = tsConfig.compilerOptions.paths || {};

    for (const { path: referencePath } of missingRefs) {
      const workspaceName = Workspaces.getWorkspaceName(
        Workspaces.workspacePathFromReferencePath(referencePath, workspacePath)
      );
      const pathAlias = aliasFromWorkspaceName(workspaceName);

      tsConfig.compilerOptions.paths[pathAlias] = [
        referencePathToAliasResolve(referencePath),
      ];
      tsConfig.compilerOptions.paths[pathAliasToGlob(pathAlias)] = [
        referencePathToAliashResolveGlob(referencePath),
      ];
    }
  }
}
