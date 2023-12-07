import { readFile, writeFile, stat } from "fs/promises";
import { glob } from "glob";
import { dirname, relative, resolve } from "path";
import picocolors from "picocolors";
import { format } from "prettier";
import type { OpaqueNumber } from "typeroo/number";
import type { OpaqueString } from "typeroo/string";
import watcher from "@parcel/watcher";

const { red, yellow, green, gray, blue } = picocolors;

/// CLI

const verbose = !!process.argv.find((arg) => arg === "--verbose");
const showRedundant = !!process.argv.find((arg) => arg === "--redundant");

/// Constants

const root = process.cwd();
const rootPackagePath = "package.json" as PackagePath;

/// State

// Links
const workspaceNames = new Map<WorkspacePath, WorkspaceName>();
const workspaceDependencies = new Map<WorkspaceName, WorkspaceName[]>();

// DX state
const unlinkedBuildInfos = new Set<BuildInfoPath>();
const commandsReported = new Set<string>();

// Watchlists
const workspacePackagesWatchlist = new Set<PackagePath>();
const buildInfoWatchlist = new Set<BuildInfoPath>();

/// Main

startWatcher().then(() => processRootPackageAdd());

/// Watcher

//// Events processing

function startWatcher() {
  return watcher.subscribe(root, (err, events) => {
    if (err) {
      error("Filesystem watcher error!");
      log(err);
    }

    events.forEach((event) => {
      const path = relative(root, event.path);

      switch (true) {
        case path === rootPackagePath:
          return processRootPackageWatchEvent(event);

        case workspacePackagesWatchlist.has(path as PackagePath):
          return processWorkspacePackageWatchEvent(event, path as PackagePath);

        case buildInfoWatchlist.has(path as BuildInfoPath):
          return processBuildInfoWatchEvent(event, path as BuildInfoPath);
      }
    });
  });
}

function processRootPackageWatchEvent(event: watcher.Event) {
  switch (event.type) {
    case "create":
      return processRootPackageCreate();

    case "update":
      return processRootPackageChange();

    case "delete":
      return processRootPackageDelete();
  }
}

function processWorkspacePackageWatchEvent(
  event: watcher.Event,
  packagePath: PackagePath
) {
  switch (event.type) {
    case "create":
      return processWorkspacePackageCreate(packagePath);

    case "update":
      return processWorkspacePackageUpdate(packagePath);

    case "delete":
      return processWorkspacePackageDelete(packagePath);
  }
}

function processBuildInfoWatchEvent(
  event: watcher.Event,
  buildInfoPath: BuildInfoPath
) {
  switch (event.type) {
    case "create":
      return processBuildInfoCreate(buildInfoPath);

    case "update":
      return processBuildInfoUpdate(buildInfoPath);

    case "delete":
      return processBuildInfoDelete(buildInfoPath);
  }
}

//// Watchlists management

function watchWorkspacePackage(workspacePath: WorkspacePath) {
  debug("Watching workspace", workspacePath);
  const packagePath = getWorkspacePackagePath(workspacePath);
  workspacePackagesWatchlist.add(packagePath);

  return stat(packagePath)
    .catch(() => {})
    .then((stats) => stats && processWorkspacePackageCreate(packagePath));
}

async function watchBuildInfo(workspacePath: WorkspacePath) {
  const buildInfoPath = getBuildInfoPath(workspacePath);
  debug("Watching build info", workspacePath, buildInfoPath);
  buildInfoWatchlist.add(buildInfoPath);
  await stat(buildInfoPath)
    .catch(() => {})
    .then<any>((stats) => stats && processBuildInfoCreate(buildInfoPath));
}

//// Root package.json events processing

async function processRootPackageAdd() {
  const rootPackage = await readPackage(rootPackagePath).catch(() =>
    warn(
      "package.json not found, make sure you are in the root directory. The processing will begine once the file is created."
    )
  );
  if (!rootPackage) return;

  return processRootPackageCreate(rootPackage);
}

async function processRootPackageCreate(argPackage?: Package) {
  debug("Detected package.json create, initializing processing");

  // Use already read package.json if provided
  const rootPackage = argPackage || (await readPackage(rootPackagePath));

  const workspacePaths = await workspacesFromPackage(rootPackage);
  debug("Found workspaces", workspacePaths);

  // Before doing anything, we need to parse and store the workspace names
  // so they are always available for the rest of the processing
  await initWorkspaceNames(workspacePaths);

  // Update the workspace tsconfig.json files with proper config if necessary
  await Promise.all(
    workspacePaths.map((workspacePath) =>
      mutateTSConfig(
        getTSConfigPath(workspacePath),
        (tsConfig, readFromDisk) => {
          const result = mutateConfigureWorkspaceTSConfig(
            tsConfig,
            !readFromDisk
          );
          if (result !== false)
            log(
              `Configured ${green(
                getWorkspaceName(workspacePath)
              )} tsconfig.json`
            );
          return result;
        },
        () => cloneDeepJSON(defaultTSConfig)
      )
    )
  );

  // Setup the root config if necessary
  await mutateTSConfig(
    getTSConfigPath(),
    (tsConfig) => {
      const prevTSConfig = cloneDeepJSON(tsConfig);

      delete tsConfig.include;
      delete tsConfig.exclude;
      tsConfig.files = [];
      tsConfig.references = referencesFromWorkspacePaths(workspacePaths);

      if (deepEqualJSON(tsConfig, prevTSConfig)) return false;
      log("Configured the root tsconfig.json");
    },
    () => cloneDeepJSON(defaultRootTSConfig)
  );

  return Promise.all(workspacePaths.map(watchWorkspacePackage));
}

async function processRootPackageChange() {
  debug("Detected package.json change, updating watchlist");

  const rootPackage = await readPackage(rootPackagePath);

  const workspaces = await workspacesFromPackage(rootPackage);
  debug("Found workspaces", workspaces);

  const watchedWorkspaces = getWatchedWorkspacePaths();

  if (areEqual(workspaces, watchedWorkspaces)) {
    debug("Workspaces list unchanged, skipping");
    return;
  }

  const missingWorkspaces = getMissingItems(watchedWorkspaces, workspaces);
  const redundantWorkspaces = getRedundantItems(watchedWorkspaces, workspaces);
  log(
    `Workspaces list updated, ${
      missingWorkspaces.length
        ? `added: ${missingWorkspaces.map(green).join(", ")}` +
          (redundantWorkspaces.length ? "; " : "")
        : ""
    }${
      redundantWorkspaces.length
        ? `removed: ${redundantWorkspaces.map(gray).join(", ")}`
        : ""
    }; processing`
  );

  // Update the workspace names before updating the watchlist
  await initWorkspaceNames(workspaces);

  // Remove redundant workspaces
  redundantWorkspaces.forEach((workspacePath) => {
    // Update the watchlists
    workspacePackagesWatchlist.delete(getWorkspacePackagePath(workspacePath));
    buildInfoWatchlist.delete(getBuildInfoPath(workspacePath));
    // Clean up the workspace links
    workspaceDependencies.delete(getWorkspaceName(workspacePath));
    workspaceNames.delete(workspacePath);
  });

  // Add missing workspaces
  missingWorkspaces.forEach(watchWorkspacePackage);
}

async function processRootPackageDelete() {
  warn("package.json has been deleted, pausing processing");

  // Clean up watchlists
  buildInfoWatchlist.clear();
  workspacePackagesWatchlist.clear();

  // Clean up DX state
  commandsReported.clear();
  unlinkedBuildInfos.clear();

  // Clean up links
  workspaceDependencies.clear();
  workspaceNames.clear();
}

//// Workspace package.json events processing

function processWorkspacePackageCreate(packagePath: PackagePath) {
  return processWorkspacePackageWrite(packagePath, true);
}

async function processWorkspacePackageUpdate(packagePath: PackagePath) {
  return processWorkspacePackageWrite(packagePath);
}

async function processWorkspacePackageWrite(
  packagePath: PackagePath,
  create?: boolean
) {
  debug(
    `Detected workspace package.json ${create ? "create" : "update"}`,
    packagePath
  );

  const workspacePath = packagePathToWorkspacePath(packagePath);
  const prevName = getWorkspaceName(workspacePath);

  const pkg = await readPackage(packagePath);
  const dependencies = getPackageDependencies(pkg);
  const workspaceName = pkg.name;
  debug("Found workspace dependencies", workspaceName, dependencies);

  // Assign the workspace links
  workspaceNames.set(workspacePath, workspaceName);
  workspaceDependencies.delete(prevName);
  workspaceDependencies.set(workspaceName, dependencies);

  if (!create && prevName !== workspaceName) {
    log(
      `Workspace name changed ${prevName} → ${workspaceName}, updating the references`
    );

    // Update the references
    await Promise.all(
      Array.from(workspaceDependencies.entries()).map(([name, deps]) => {
        if (!deps.includes(prevName)) return;

        const workspacePath = getWorkspacePath(name);
        return Promise.all([
          // Update the packages
          mutatePackage(getWorkspacePackagePath(workspacePath), (pkg) => {
            if (pkg.dependencies && !pkg.devDependencies?.[prevName]) {
              delete pkg.dependencies[prevName];
              pkg.dependencies[workspaceName] = "*";
              pkg.dependencies = sortObject(pkg.dependencies);
            }

            if (pkg.devDependencies && pkg.devDependencies[prevName]) {
              delete pkg.devDependencies[prevName];
              pkg.devDependencies[workspaceName] = "*";
              pkg.devDependencies = sortObject(pkg.devDependencies);
            }
          }),

          // Update references and aliases in TS config
          mutateTSConfig(getTSConfigPath(workspacePath), (tsConfig) => {
            return [
              mutateConfigureWorkspaceTSConfig(tsConfig),
              tsConfig.references
                ? mutateUpdateReferences(
                    tsConfig,
                    tsConfig.references,
                    workspacePath
                  )
                : false,
            ];
          }),
        ]);
      })
    );
  }

  if (create) return watchBuildInfo(workspacePath);
}

async function processWorkspacePackageDelete(packagePath: PackagePath) {
  debug("Detected workspace package.json unlink, TODO:", packagePath);
  warn("Function not implemented: processWorkspaceUnlink", packagePath);
  // TODO:
}

//// Build info events processing

async function processBuildInfoCreate(buildInfoPath: BuildInfoPath) {
  return processBuildInfoWrite(buildInfoPath, true);
}

async function processBuildInfoUpdate(path: BuildInfoPath) {
  return processBuildInfoWrite(path, false);
}

function processBuildInfoDelete(buildInfoPath: BuildInfoPath) {
  debug("Detected build info unlink", buildInfoPath);

  const workspacePath = buildInfoPathToWorkspacePath(buildInfoPath);
  const workspaceName = getWorkspaceName(workspacePath);

  warn(
    `The ${blue(
      workspaceName
    )} tsconfig.tsbuildinfo has been deleted, pausing processing`
  );

  unlinkedBuildInfos.add(buildInfoPath);
}

async function processBuildInfoWrite(
  buildInfoPath: BuildInfoPath,
  create?: boolean
) {
  debug(`Detected build ${create ? "create" : "update"}`, buildInfoPath);

  const workspacePath = buildInfoPathToWorkspacePath(buildInfoPath);
  const workspaceName = getWorkspaceName(workspacePath);

  if (create && unlinkedBuildInfos.has(buildInfoPath)) {
    unlinkedBuildInfos.delete(buildInfoPath);
    log(
      `The ${blue(
        workspaceName
      )} tsconfig.tsbuildinfo has been created, resuming processing`
    );
  }

  let buildInfoDeps: WorkspaceName[];
  try {
    buildInfoDeps = await getBuildInfoDependencies(buildInfoPath);
  } catch (err) {
    error("Failed to get build info dependencies", buildInfoPath);
    log(err);
    return;
  }

  debug("Found build info dependencies", buildInfoPath, buildInfoDeps);

  const workspaceDeps = getWorkspaceDependencies(workspaceName);
  const missing = getMissingItems(workspaceDeps, buildInfoDeps);
  const redundant = getRedundantItems(workspaceDeps, buildInfoDeps);

  if (showRedundant && redundant.length) {
    const command = `npm uninstall -w ${workspaceName} ${redundant
      .map((name) => name + "@*")
      .join(" ")}`;

    if (!commandsReported.has(command)) {
      commandsReported.add(command);

      warn(
        `Detected redundant dependencies in ${green(
          workspaceName
        )} package.json:`,
        gray(redundant.join(", "))
      );

      log(
        `${gray("Please run")}:
    
    ${blue(command)}`
      );
    }
  }

  if (missing.length)
    debouncedLog(
      `Dependencies changed, run the command to update package-lock.json:

    ${blue(`npm install`)}`
    );

  return Promise.all([
    missing.length &&
      mutatePackage(getWorkspacePackagePath(workspacePath), (pkg) => {
        log(
          `Detected missing dependencies in ${green(
            workspaceName
          )}, updating package.json`
        );
        pkg.dependencies = pkg.dependencies || {};
        missing.reduce((deps, name) => {
          deps[name] = "*";
          return deps;
        }, pkg.dependencies);
        pkg.dependencies = sortObject(pkg.dependencies);
      }),

    mutateTSConfig(getTSConfigPath(workspacePath), (tsConfig) => {
      const references = referencesFromWorkspaces(workspacePath, buildInfoDeps);
      return [
        mutateConfigureWorkspaceTSConfig(tsConfig),
        mutateUpdateReferences(tsConfig, references, workspacePath),
      ];
    }),
  ]);
}

function mutateUpdateReferences(
  tsConfig: TSConfig,
  references: TSConfigReference[],
  workspacePath: WorkspacePath
) {
  const prevTSConfig = cloneDeepJSON(tsConfig);
  const tsConfigReferences = tsConfig?.references || [];

  debug("References changed!");
  debug("Actual references:", tsConfigReferences);
  debug("The tsconfig.tsbuildinfo references:", references);

  tsConfig.references = references;

  const redundantRefs = getRedundantItems(tsConfigReferences, references);
  const missingRefs = getMissingItems(tsConfigReferences, references);

  mutateRemoveRedundantAliases(tsConfig, redundantRefs);
  mutateAddMissingAliases(tsConfig, missingRefs, workspacePath);

  if (deepEqualJSON(prevTSConfig, tsConfig)) return false;

  log(
    `Writing ${green(
      getWorkspaceName(workspacePath)
    )} tsconfig.json with updated references list`
  );
  debug("References:", references);
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
  workspacePath: WorkspacePath
) {
  tsConfig.compilerOptions = tsConfig.compilerOptions || {};
  tsConfig.compilerOptions.paths = tsConfig.compilerOptions.paths || {};

  for (const { path: referencePath } of missingRefs) {
    const workspaceName = getWorkspaceName(
      workspacePathFromReferencePath(referencePath, workspacePath)
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

/// Package

async function readPackage(packagePath: PackagePath) {
  const content = await readFile(packagePath, "utf-8");
  return JSON.parse(content) as Package;
}

function getPackageDependencies(pkg: Package) {
  return packageDependenciesToWorkspaceNames(pkg.dependencies).concat(
    packageDependenciesToWorkspaceNames(pkg.devDependencies)
  );
}

function packageDependenciesToWorkspaceNames(
  dependencies: Record<WorkspaceName, string> | undefined
) {
  const names = Array.from(workspaceNames.values());
  const dependenciesNames = Object.keys(dependencies || {}) as WorkspaceName[];
  return dependenciesNames.filter((name) => names.includes(name));
}

function getWorkspacePackagePath(workspacePath: WorkspacePath) {
  return relative(root, resolve(workspacePath, "package.json")) as PackagePath;
}

function packagePathToWorkspacePath(packagePath: PackagePath) {
  return dirname(packagePath) as WorkspacePath;
}

async function mutatePackage(
  packagePath: PackagePath,
  mutator: (pkg: Package) => boolean | Array<boolean | void> | void
) {
  const pkg = await readPackage(packagePath);

  const mutatorResult = mutator(pkg);
  const skipWrite = Array.isArray(mutatorResult)
    ? mutatorResult.every((result) => result === false)
    : mutatorResult === false;
  if (skipWrite) return;

  const content = await format(JSON.stringify(pkg), { parser: "json" });
  await writeFile(packagePath, content);
}

/// TSConfig

function aliasFromWorkspaceName(workspaceName: WorkspaceName) {
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

function referencesFromWorkspaces(
  workspacePath: WorkspacePath,
  dependencies: WorkspaceName[]
): TSConfigReference[] {
  return dependencies.map((dependencyName) => ({
    path: getReferencePath(getWorkspacePath(dependencyName), workspacePath),
  }));
}

function referencesFromWorkspacePaths(
  workspacePaths: WorkspacePath[]
): TSConfigReference[] {
  return workspacePaths.map((workspacePath) => ({
    path: getReferencePath(workspacePath),
  }));
}

function getReferencePath(
  dependencyPath: WorkspacePath,
  workspacePath?: WorkspacePath
) {
  return relative(
    workspacePath || root,
    dependencyPath
  ) as TSConfigReferencePath;
}

async function readTSConfig(path: TSConfigPath) {
  const content = await readFile(path, "utf-8");
  return JSON.parse(content) as TSConfig;
}

function areReferencesEqual(a: TSConfigReference[], b: TSConfigReference[]) {
  return areEqual(a.map(pathFromReference), b.map(pathFromReference));
}

function pathFromReference(reference: TSConfigReference) {
  return reference.path;
}

async function mutateTSConfig(
  tsConfigPath: TSConfigPath,
  mutator: (
    tsConfig: TSConfig,
    readFromDisk: boolean
  ) => boolean | Array<boolean | void> | void,
  getDefault?: () => TSConfig | undefined
) {
  const [tsConfig, readFromDisk] = await readTSConfig(tsConfigPath)
    .then((config) => [config, true] as const)
    .catch((err) => {
      if (getDefault) return [getDefault(), false] as const;
      error(`Error reading the ${tsConfigPath}`);
      log(new Error().stack);
      process.exit(1);
    });
  if (!tsConfig) return;

  const mutatorResult = mutator(tsConfig, readFromDisk);
  const skipWrite = Array.isArray(mutatorResult)
    ? mutatorResult.every((result) => result === false)
    : mutatorResult === false;
  if (skipWrite) return;

  const content = await format(JSON.stringify(tsConfig), { parser: "json" });
  await writeFile(tsConfigPath, content);
}

function getTSConfigPath(workspace?: WorkspacePath) {
  return relative(
    root,
    resolve(workspace || "./", "tsconfig.json")
  ) as TSConfigPath;
}

function mutateConfigureWorkspaceTSConfig(tsConfig: TSConfig, force?: boolean) {
  if (
    !force &&
    tsConfig.compilerOptions &&
    tsConfig.compilerOptions.composite === true &&
    tsConfig.compilerOptions.outDir === ".ts"
  )
    return false;

  tsConfig.compilerOptions = tsConfig.compilerOptions || {};
  Object.assign(tsConfig.compilerOptions, defaultTSConfig.compilerOptions);
}

const defaultRootTSConfig: TSConfig = {
  files: [],
  include: undefined,
  exclude: undefined,
};

const defaultTSConfig: TSConfig = {
  include: ["**/*.ts", "**/*.tsx"],
  compilerOptions: {
    composite: true,
    outDir: ".ts",
    tsBuildInfoFile: undefined,
  },
};

/// Workspaces

async function initWorkspaceNames(workspacePaths: WorkspacePath[]) {
  const names = await Promise.all(
    workspacePaths.map(async (workspacePath) => {
      try {
        const pkg = await readPackage(getWorkspacePackagePath(workspacePath));
        const name = pkg.name as WorkspaceName;
        return [workspacePath, name] as const;
      } catch (_error) {
        warn(
          `Workspace package.json not found, ignoring ${green(workspacePath)}`,
          workspacePath
        );
      }
    })
  );

  workspaceNames.clear();
  names.forEach((name) => name && workspaceNames.set(...name));
}

async function workspacesFromPackage(pkg: Package): Promise<WorkspacePath[]> {
  return (await glob(pkg.workspaces || [])) as WorkspacePath[];
}

function workspacePathFromReferencePath(
  referencePath: TSConfigReferencePath,
  workspacePath: WorkspacePath
) {
  return relative(root, resolve(workspacePath, referencePath)) as WorkspacePath;
}

function getWorkspaceName(workspacePath: WorkspacePath) {
  const name = workspaceNames.get(workspacePath);
  if (!name) {
    error("Internal error: workspace name not found", workspacePath);
    log(new Error().stack);
    process.exit(1);
  }
  return name;
}

function getWorkspacePath(workspaceName: WorkspaceName) {
  const path = Array.from(workspaceNames).find(
    ([, name]) => name === workspaceName
  )?.[0];
  if (!path) {
    error("Internal error: workspace path not found", workspaceName);
    log(new Error().stack);
    process.exit(1);
  }
  return path as WorkspacePath;
}

function isFileBelongsToWorkspace(
  filePath: WorkspaceFilePath,
  workspacePath: WorkspacePath
) {
  return filePath.startsWith(workspacePath);
}

function getWorkspaceDependencies(workspaceName: WorkspaceName) {
  const deps = workspaceDependencies.get(workspaceName);
  if (!deps) {
    error("Internal error: workspace dependencies not found", workspaceName);
    log(new Error().stack);
    process.exit(1);
  }
  return deps;
}

function getWatchedWorkspacePaths() {
  return [...workspacePackagesWatchlist].map(packagePathToWorkspacePath);
}

/// Build info

async function readBuildInfo(buildInfoPath: BuildInfoPath) {
  const content = await readFile(buildInfoPath, "utf-8");
  return JSON.parse(content) as BuildInfo;
}

function buildInfoFileToWorkspaceFile(
  buildInfoPath: BuildInfoPath,
  fileName: BuildInfoFileName
) {
  return relative(
    root,
    resolve(dirname(buildInfoPath), fileName)
  ) as WorkspaceFilePath;
}

function getBuildInfoPath(workspacePath: WorkspacePath) {
  return relative(
    root,
    resolve(workspacePath, ".ts/tsconfig.tsbuildinfo")
  ) as BuildInfoPath;
}

function buildInfoPathToWorkspacePath(buildInfoPath: BuildInfoPath) {
  return relative(root, resolve(dirname(buildInfoPath), "..")) as WorkspacePath;
}

/// Build info parsing

async function getBuildInfoDependencies(
  buildInfoPath: BuildInfoPath
): Promise<WorkspaceName[]> {
  const buildInfo = await withRetry(() => readBuildInfo(buildInfoPath), 50, 10);

  const workspacePath = buildInfoPathToWorkspacePath(buildInfoPath);
  const workspaceName = getWorkspaceName(workspacePath);

  const indices = getLocalBuildInfoFileIndices(buildInfo);
  const allFileNames = new Set<BuildInfoFileName>();

  for (const index of indices) {
    const listIds = getBuildInfoListIds(index, buildInfo);
    const listFileIds = getBuildInfoListsFileIds(listIds, buildInfo);
    const fileNames = getBuildInfoFileNames(listFileIds, buildInfo);
    fileNames.forEach((fileName) => allFileNames.add(fileName));
  }

  const deps = new Set<WorkspaceName>();

  allFileNames.forEach((buildInfoFile) => {
    const file = buildInfoFileToWorkspaceFile(buildInfoPath, buildInfoFile);
    const workspacePath = getWatchedWorkspacePaths().find((workspace) =>
      isFileBelongsToWorkspace(file, workspace)
    );
    if (!workspacePath) return;

    const name = getWorkspaceName(workspacePath);
    if (name !== workspaceName) deps.add(name);
  });

  return [...deps];
}

const localBuildInfoFileRE = /^(?!.*(?:\.\.\/\.\.\/|\.\.\/node_modules))/;

function getLocalBuildInfoFileIndices(buildInfo: BuildInfo) {
  const indices: BuildInfoFileIndex[] = [];
  for (const [indexStr, fileName] of Object.entries(
    buildInfo.program.fileNames
  )) {
    const index = parseInt(indexStr) as BuildInfoFileIndex;
    if (localBuildInfoFileRE.test(fileName)) indices.push(index);
  }
  return indices;
}

function getBuildInfoListIds(
  fileIndex: BuildInfoFileIndex,
  buildInfo: BuildInfo
): BuildInfoListId[] {
  const fileId = buildInfoFileIndexToId(fileIndex);
  return (
    buildInfo.program.referencedMap
      ?.filter(([refFileId]) => refFileId === fileId)
      ?.map(([_, listId]) => listId) || []
  );
}

function getBuildInfoListsFileIds(
  listIds: BuildInfoListId[],
  buildInfo: BuildInfo
): BuildInfoFileId[] {
  const fileIds = new Set<BuildInfoFileId>();
  for (const listId of listIds) {
    const listIndex = buildInfoListIdToIndex(listId);
    const listFileIds = buildInfo.program.fileIdsList?.[listIndex];
    listFileIds?.forEach((fileId) => fileIds.add(fileId));
  }
  return [...fileIds];
}

function getBuildInfoFileNames(
  fileIds: BuildInfoFileId[],
  buildInfo: BuildInfo
): BuildInfoFileName[] {
  return fileIds
    .map(
      (fileId) => buildInfo.program.fileNames[buildInfoFileIdToIndex(fileId)]
    )
    .filter((f) => !!f) as BuildInfoFileName[];
}

function buildInfoListIdToIndex(id: BuildInfoListId) {
  return (id - 1) as BuildInfoListIndex;
}

function buildInfoFileIndexToId(index: BuildInfoFileIndex) {
  return (index + 1) as BuildInfoFileId;
}

function buildInfoFileIdToIndex(id: BuildInfoFileId) {
  return (id - 1) as BuildInfoFileIndex;
}

/// Types

//// Package

interface Package {
  name: WorkspaceName;
  dependencies?: PackageDependencies;
  devDependencies?: Record<WorkspaceName, string>;
  workspaces?: string[];
}

type PackageDependencies = Record<WorkspaceName, string>;

type PackagePath = OpaqueString<typeof packagePathBrand>;
declare const packagePathBrand: unique symbol;

//// TSConfig

interface TSConfig {
  compilerOptions?: {
    composite?: boolean;
    paths?: TSConfigAliases;
    outDir?: string;
    tsBuildInfoFile?: string | undefined;
  };
  files?: string[];
  include?: string[] | undefined;
  exclude?: string[] | undefined;
  references?: TSConfigReference[];
}

type TSConfigAliases = Record<TSConfigAlias, [TSConfigAliasResolve]>;

interface TSConfigReference {
  path: TSConfigReferencePath;
}

type TSConfigAlias = OpaqueString<typeof tsConfigPathAliasBrand>;
declare const tsConfigPathAliasBrand: unique symbol;

type TSConfigReferencePath = OpaqueString<typeof tsConfigReferencePathBrand>;
declare const tsConfigReferencePathBrand: unique symbol;

type TSConfigAliasResolve = OpaqueString<typeof tsConfigPathResolveBrand>;
declare const tsConfigPathResolveBrand: unique symbol;

type TSConfigPath = OpaqueString<typeof tsConfigPathBrand>;
declare const tsConfigPathBrand: unique symbol;

//// Workspaces

type WorkspacePath = OpaqueString<typeof workspacePathBrand>;
declare const workspacePathBrand: unique symbol;

type WorkspaceName = OpaqueString<typeof workspaceNameBrand>;
declare const workspaceNameBrand: unique symbol;

type WorkspaceFilePath = OpaqueString<typeof workspaceFilePathBrand>;
declare const workspaceFilePathBrand: unique symbol;

//// Build info

interface BuildInfo {
  program: {
    fileNames: Record<BuildInfoFileIndex, BuildInfoFileName>;
    referencedMap?: [BuildInfoFileId, BuildInfoListId][];
    fileIdsList?: Record<BuildInfoListIndex, BuildInfoFileId[]>;
  };
}

type BuildInfoPath = OpaqueString<typeof buildInfoPathBrand>;
declare const buildInfoPathBrand: unique symbol;

type BuildInfoFileId = OpaqueNumber<typeof buildInfoFileIdBrand>;
declare const buildInfoFileIdBrand: unique symbol;

type BuildInfoFileIndex = OpaqueNumber<typeof buildInfoFileIndexBrand>;
declare const buildInfoFileIndexBrand: unique symbol;

type BuildInfoFileName = OpaqueString<typeof buildInfoFileNameBrand>;
declare const buildInfoFileNameBrand: unique symbol;

type BuildInfoListId = OpaqueNumber<typeof buildInfoListIdBrand>;
declare const buildInfoListIdBrand: unique symbol;

type BuildInfoListIndex = OpaqueNumber<typeof buildInfoListIndexBrand>;
declare const buildInfoListIndexBrand: unique symbol;

/// Utils

function debug(...message: any[]) {
  if (verbose) console.debug(...message);
}

const debouncedLog = debounceByArgs(log, 50);

function log(...message: any[]) {
  console.log(...message, "\n");
}

function warn(...message: any[]) {
  console.warn(yellow("Warning:"), ...message, "\n");
}

function error(...message: any[]) {
  console.error(red("Error:"), ...message, "\n");
}

async function withRetry<Type>(
  fn: () => Promise<Type>,
  maxRetries: number,
  baseDelay: number
): Promise<Type> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= maxRetries) throw error;
      const delayTime = baseDelay * Math.pow(1.6, attempt);
      await delay(delayTime);
      attempt++;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function areEqual<Type>(a: Type[], b: Type[]) {
  return a.length === b.length && a.every((item) => b.includes(item));
}

function getMissingItems<Type>(actual: Type[], next: Type[]) {
  return next.filter((item) => !actual.includes(item));
}

function getRedundantItems<Type>(actual: Type[], next: Type[]) {
  return actual.filter((item) => !next.includes(item));
}

function cloneDeepJSON<Type>(value: Type): Type {
  if (typeof value !== "object" || value === null) return value;

  if (Array.isArray(value))
    return value.map((item) => cloneDeepJSON(item)) as Type;

  const copiedObject: Record<string, any> = {};
  for (const key in value)
    if (Object.prototype.hasOwnProperty.call(value, key))
      copiedObject[key] = cloneDeepJSON(value[key]);

  return copiedObject as Type;
}

function deepEqualJSON<Type>(value1: Type, value2: Type): boolean {
  if (value1 === value2) return true;

  if (
    typeof value1 !== "object" ||
    typeof value2 !== "object" ||
    value1 === null ||
    value2 === null
  )
    return false;

  if (Array.isArray(value1) && Array.isArray(value2)) {
    if (value1.length !== value2.length) return false;

    for (let i = 0; i < value1.length; i++)
      if (!deepEqualJSON(value1[i], value2[i])) return false;

    return true;
  }

  if (Array.isArray(value1) || Array.isArray(value2)) return false;

  const keys1 = Object.keys(value1);
  const keys2 = Object.keys(value2);

  if (keys1.length !== keys2.length) return false;

  for (const key of keys1) {
    if (!Object.prototype.hasOwnProperty.call(value2, key)) return false;

    if (!deepEqualJSON(value1[key as keyof Type], value2[key as keyof Type]))
      return false;
  }

  return true;
}

function sortObject<Type extends Object>(obj: Type): Type {
  const sortedObj = {} as Type;
  Object.keys(obj)
    .sort()
    .forEach((key) => {
      sortedObj[key as keyof Type] = obj[key as keyof Type];
    });
  return sortedObj;
}

function debounceByArgs<Fn extends (...args: any[]) => void>(
  func: Fn,
  waitFor: number
): (...args: Parameters<Fn>) => void {
  const timeouts: Record<string, NodeJS.Timeout> = {};

  return function (...args: Parameters<Fn>): void {
    const argsKey = JSON.stringify(args);
    const later = () => {
      delete timeouts[argsKey];
      func(...args);
    };

    clearTimeout(timeouts[argsKey]);
    timeouts[argsKey] = setTimeout(later, waitFor);
  };
}
