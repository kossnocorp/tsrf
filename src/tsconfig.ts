import { readFile, writeFile } from "fs/promises";
import { relative, resolve } from "path";
import picocolors from "picocolors";
import { format } from "prettier";
import { OpaqueString } from "typeroo/string/index.js";
import { State } from "./state.js";
import { Utils } from "./utils.js";
import { Workspaces } from "./workspaces.js";

const { green } = picocolors;

export namespace TSConfig {
  /// Types

  export interface TSConfig {
    compilerOptions?: TSConfigCompilerOptions;
    files?: string[];
    include?: string[] | undefined;
    exclude?: string[] | undefined;
    references?: TSConfigReference[];
  }

  export interface TSConfigCompilerOptions {
    composite?: boolean;
    paths?: TSConfigAliases;
    outDir?: string;
    tsBuildInfoFile?: string | undefined;
    noEmit?: boolean;
    skipLibCheck?: boolean;
    jsx?: "preserve" | undefined;
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

  export function readTSConfigs(workspacePaths: Set<Workspaces.WorkspacePath>) {
    return Promise.all(
      Array.from(workspacePaths).map(async (workspacePath) => {
        const config = await readTSConfig(getTSConfigPath(workspacePath)).catch(
          () => {}
        );

        if (config)
          return Workspaces.addRequirement(
            workspacePath,
            Workspaces.Requirement.TSConfig
          );

        Utils.warn(
          `Workspace tsconfig.json not found, ignoring ${green(workspacePath)}`,
          workspacePath
        );

        Workspaces.removeRequirement(
          workspacePath,
          Workspaces.Requirement.TSConfig
        );
      })
    );
  }

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
    return `${referencePath}/` as TSConfigAliasResolve;
  }

  function referencePathToAliashResolveGlob(
    referencePath: TSConfigReferencePath
  ) {
    return `${referencePath}/*` as TSConfigAliasResolve;
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

  export async function readTSConfig(path: TSConfigPath) {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content) as TSConfig;
  }

  async function mutateTSConfig(
    tsConfigPath: TSConfigPath,
    mutator: (
      tsConfig: TSConfig,
      fromDisk: boolean
    ) => Utils.MaybeArray<boolean | void>,
    getDefault?: () => TSConfig
  ) {
    let fromDisk = true;
    let tsConfig = await readTSConfig(tsConfigPath).catch(() => {});

    if (!tsConfig) {
      if (getDefault) {
        tsConfig = getDefault();
        fromDisk = false;
        if (!tsConfig) return;
      } else {
        Utils.error(`Error reading the ${tsConfigPath}`);
        Utils.log(new Error().stack);
        process.exit(1);
      }
    }

    const mutatorResult = mutator(tsConfig, fromDisk);

    const skipWrite = Array.isArray(mutatorResult)
      ? mutatorResult.every((result) => result === false)
      : mutatorResult === false;
    if (skipWrite) return;

    const content = await format(JSON.stringify(tsConfig), { parser: "json" });
    await writeFile(tsConfigPath, content);
  }

  export function getTSConfigPath(workspace?: Workspaces.WorkspacePath) {
    return relative(
      State.root,
      resolve(workspace || "./", "tsconfig.json")
    ) as TSConfigPath;
  }

  function mutateConfigureWorkspaceTSConfig(tsConfig: TSConfig) {
    if (
      isCompilerOptionsSatisfactory(
        tsConfig?.compilerOptions,
        defaultTSConfigCompilerOptions
      )
    )
      return false;

    tsConfig.compilerOptions = tsConfig.compilerOptions || {};
    Object.assign(tsConfig.compilerOptions, defaultTSConfigCompilerOptions);
  }

  const defaultRootTSConfig: TSConfig = {
    files: [],
    include: undefined,
    exclude: undefined,
  };

  const defaultTSConfigCompilerOptions: TSConfigCompilerOptions = {
    composite: true,
    outDir: ".ts",
    tsBuildInfoFile: ".ts/tsconfig.tsbuildinfo",
    noEmit: false,
  };

  function isCompilerOptionsSatisfactory(
    options: TSConfigCompilerOptions | undefined,
    defaultOptions: TSConfigCompilerOptions
  ): boolean {
    if (!options) return false;

    for (const key in defaultOptions) {
      if (!defaultOptions.hasOwnProperty(key)) continue;

      const defaultValue = defaultOptions[key as keyof TSConfigCompilerOptions];
      const optionValue = options[key as keyof TSConfigCompilerOptions];

      if (defaultValue === undefined && optionValue) return false;
      else if (defaultValue !== undefined && optionValue !== defaultValue)
        return false;
    }

    return true;
  }

  export function configureTSConfigs(
    workspacePaths: Set<Workspaces.WorkspacePath>
  ) {
    return Promise.all(Array.from(workspacePaths).map(configureTSConfig));
  }

  async function configureTSConfig(workspacePath: Workspaces.WorkspacePath) {
    return mutateTSConfig(getTSConfigPath(workspacePath), (tsConfig) => {
      const result = mutateConfigureWorkspaceTSConfig(tsConfig);

      if (result !== false)
        Utils.log(
          `Configured ${green(
            Workspaces.getWorkspaceName(workspacePath)
          )} tsconfig.json`
        );

      return result;
    });
  }

  export function configureRoot(workspacePaths: Set<Workspaces.WorkspacePath>) {
    return mutateTSConfig(
      getTSConfigPath(),
      (tsConfig, fromDisk) => {
        const references = referencesFromWorkspacePaths(workspacePaths);

        if (
          fromDisk &&
          !tsConfig.include &&
          !tsConfig.exclude &&
          tsConfig.files?.length === 0 &&
          areReferencesEqual(tsConfig.references || [], references)
        )
          return false;

        delete tsConfig.include;
        delete tsConfig.exclude;
        tsConfig.files = [];
        tsConfig.references = references;

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
      mutateConfigureWorkspaceTSConfig(tsConfig),
      tsConfig.references
        ? mutateUpdateReferences(tsConfig, tsConfig.references, workspacePath)
        : false,
    ]);
  }

  export function updateReferences(
    workspacePath: Workspaces.WorkspacePath,
    deps: Workspaces.WorkspaceName[]
  ) {
    return mutateTSConfig(getTSConfigPath(workspacePath), (tsConfig) => {
      const references = referencesFromWorkspaceNames(workspacePath, deps);
      return [
        mutateConfigureWorkspaceTSConfig(tsConfig),
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

  function areReferencesEqual(a: TSConfigReference[], b: TSConfigReference[]) {
    return Utils.areEqual(
      a.map(pathFromReference).sort(),
      b.map(pathFromReference).sort()
    );
  }

  function pathFromReference(reference: TSConfigReference) {
    return reference.path;
  }
}
