import { watch } from "chokidar";
import { readFile, writeFile } from "fs/promises";
import { glob } from "glob";
import { dirname, relative, resolve } from "path";
import picocolors from "picocolors";
import { format } from "prettier";
import type { OpaqueNumber } from "typeroo/number";
import type { OpaqueString } from "typeroo/string";

const { red, yellow, green, gray, blue } = picocolors;

const verbose = !!process.argv.find((arg) => arg === "--verbose");
const showRedundant = !!process.argv.find((arg) => arg === "--redundant");

const root = process.cwd();
const rootPackageJSONPath = resolve(root, "package.json") as PackageJSONPath;

let watchedWorkspaces: WorkspacePath[] = [];
const workspaceNames: Record<WorkspacePath, WorkspaceName> = {};
const workspaceDependencies: Record<WorkspaceName, WorkspaceName[]> = {};
const workspacesWatch = watchWorkspaces();

const buildInfoWatch = watchBuildInfos();

watchPackageJSON();

function watchWorkspaces() {
  const workspacesWatch = watch([]);

  workspacesWatch.on("all", async (event, path: AbsolutePackageJSONPath) => {
    switch (event) {
      case "add":
        return processWorkspaceAdd(path);

      case "change":
        return processWorkspaceChange(path);

      case "unlink":
        return processWorkspaceUnlink(path);
    }
  });

  return workspacesWatch;
}

async function processWorkspaceAdd(absolutePath: AbsolutePackageJSONPath) {
  const path = relativePackageJSONPath(absolutePath);
  debug("Detected workspace package.json", path);

  const workspacePath = packageJSONPathToWorkspacePath(path);
  const name = getWorkspaceName(workspacePath);

  debug("Watching workspace", name, `(${dirname(path)})`);

  const packageJSON = await readPackageJSON(path);
  const dependencies = extractWorkspaceDependenciesFromPackageJSON(packageJSON);

  debug("Found workspace dependencies", name, dependencies);
  workspaceDependencies[name] = dependencies;

  watchBuildInfo(workspacePath);
}

async function processWorkspaceChange(absolutePath: AbsolutePackageJSONPath) {
  const path = relativePackageJSONPath(absolutePath);
  debug("Detected workspace package.json change, TODO:", path);
  warn("Function not implemented: processWorkspaceUnlink", path);
  // TODO:
}

async function processWorkspaceUnlink(absolutePath: AbsolutePackageJSONPath) {
  const path = relativePackageJSONPath(absolutePath);
  debug("Detected workspace package.json unlink, TODO:", path);
  warn("Function not implemented: processWorkspaceUnlink", path);
  // TODO:
}

function watchBuildInfos() {
  const buildInfoWatch = watch([]);

  buildInfoWatch.on("all", async (event, path: AbsoluteBuildInfoPath) => {
    switch (event) {
      case "add":
        return processBuildInfoAdd(path);

      case "change":
        return processBuildInfoChange(path);

      case "unlink":
        return processBuildInfoUnlink(path);
    }
  });

  return buildInfoWatch;
}

const unlinkedBuildInfos = new Set<BuildInfoPath>();

async function processBuildInfoAdd(absolutePath: AbsoluteBuildInfoPath) {
  return processBuildInfoUpdate(absolutePath, true);
}

async function processBuildInfoChange(absolutePath: AbsoluteBuildInfoPath) {
  return processBuildInfoUpdate(absolutePath, false);
}

function processBuildInfoUnlink(absolutePath: AbsoluteBuildInfoPath) {
  const buildInfoPath = relativeBuildInfoPath(absolutePath);
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

const commandsReported = new Set<string>();

async function processBuildInfoUpdate(
  absolutePath: AbsoluteBuildInfoPath,
  add?: boolean
) {
  const buildInfoPath = relativeBuildInfoPath(absolutePath);
  debug(`Detected build ${add ? "add" : "change"}`, buildInfoPath);

  const workspacePath = buildInfoPathToWorkspacePath(buildInfoPath);
  const workspaceName = getWorkspaceName(workspacePath);

  if (add && unlinkedBuildInfos.has(buildInfoPath)) {
    unlinkedBuildInfos.delete(buildInfoPath);
    log(
      `The ${blue(
        workspaceName
      )} tsconfig.tsbuildinfo has been created, resuming processing`
    );
  }

  let buildInfoDependencies: WorkspaceName[];
  try {
    buildInfoDependencies = await getBuildInfoDependencies(buildInfoPath);
  } catch (err) {
    error("Failed to get build info dependencies", buildInfoPath);
    log(err);
    return;
  }

  debug("Found build info dependencies", buildInfoPath, buildInfoDependencies);

  const workspaceDeps = getWorkspaceDependencies(workspaceName);
  const missing = getMissingItems(workspaceDeps, buildInfoDependencies);
  const redundant = getRedundantItems(workspaceDeps, buildInfoDependencies);

  if (missing.length) {
    const command = `npm install -w ${workspaceName} ${missing
      .map((name) => name + "@*")
      .join(" ")}`;

    if (!commandsReported.has(command)) {
      commandsReported.add(command);

      warn(
        `Detected missing dependencies in ${green(
          workspaceName
        )} package.json:`,
        gray(missing.join(", "))
      );

      log(
        `${gray("Please run")}:
    
    ${blue(command)}`
      );
    }
  }

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

  await mutateTSConfig(getTSConfigPath(workspacePath), (tsConfig) => {
    const references = dependeciesToReferences(
      workspacePath,
      buildInfoDependencies
    );
    const tsConfigReferences = tsConfig?.references || [];
    const referencesUnchanged = areReferencesEqual(
      references,
      tsConfigReferences
    );

    if (referencesUnchanged) return false;

    debug("References changed!");
    debug("Actual references:", tsConfigReferences);
    debug("The tsconfig.tsbuildinfo references:", references);

    log(
      `Writing ${blue(
        getWorkspaceName(workspacePath)
      )} tsconfig.json with updated references list`
    );
    debug("References:", references);

    tsConfig.references = references;

    tsConfig.compilerOptions = tsConfig.compilerOptions || {};
    tsConfig.compilerOptions.paths = tsConfig.compilerOptions.paths || {};

    const redundant = getRedundantItems(tsConfigReferences, references);
    const missing = getMissingItems(tsConfigReferences, references);

    for (const { path: relativeWorkspacePath } of redundant) {
      const pathPattern = findTSConfigRedundantPathPattern(
        tsConfig.compilerOptions.paths,
        relativeWorkspacePath
      );
      if (pathPattern) {
        delete tsConfig.compilerOptions.paths[pathPattern];
        delete tsConfig.compilerOptions.paths[getTSConfigGlobPath(pathPattern)];
      }
    }

    for (const { path: relativeWorkspacePath } of missing) {
      const workspaceName = getWorkspaceName(
        relativeWorkspacePathToWorkspacePath(
          relativeWorkspacePath,
          workspacePath
        )
      );
      const pathPattern = workspaceNameToPathPattern(workspaceName);

      tsConfig.compilerOptions.paths[pathPattern] = [
        relativeWorkspacePathToPathPattern(relativeWorkspacePath),
      ];
      tsConfig.compilerOptions.paths[getTSConfigGlobPath(pathPattern)] = [
        relativeWorkspacePathToGlobPattern(relativeWorkspacePath),
      ];
    }
  });
}

function workspaceNameToPathPattern(name: WorkspaceName) {
  return name as unknown as WorkspacePathPattern;
}

function findTSConfigRedundantPathPattern(
  tsConfigPaths: TSConfigPaths,
  relativeWorkspacePath: RelativeWorkspacePath
) {
  return Object.entries(tsConfigPaths).find(([_, paths]) =>
    paths.includes(
      relativeWorkspacePath as unknown as RelativeWorkspacePathPattern
    )
  )?.[0] as WorkspacePathPattern | undefined;
}

function relativeWorkspacePathToPathPattern(
  relativeWorkspacePath: RelativeWorkspacePath
) {
  return relativeWorkspacePath as unknown as RelativeWorkspacePathPattern;
}

function relativeWorkspacePathToGlobPattern(
  relativeWorkspacePath: RelativeWorkspacePath
) {
  return (relativeWorkspacePath + "/*") as RelativeWorkspacePathPattern;
}

function getTSConfigGlobPath(pathPattern: WorkspacePathPattern) {
  return (pathPattern + "/*") as WorkspacePathPattern;
}
function dependeciesToReferences(
  workspacePath: WorkspacePath,
  dependencies: WorkspaceName[]
): TSConfigReference[] {
  return dependencies.map((dependencyName) => ({
    path: getRelativeWorkspacePath(
      getWorkspacePath(dependencyName),
      workspacePath
    ),
  }));
}

function watchBuildInfo(workspace: WorkspacePath) {
  const path = buildWathInfoPath(workspace);
  debug("Watching build info", workspace, path);

  buildInfoWatch.add(path);
}

function watchPackageJSON() {
  const packageJSONWatch = watch(rootPackageJSONPath);

  packageJSONWatch.on("all", async (event, _path) => {
    switch (event) {
      case "add":
        return processPackageJSONAdd();

      case "change":
        return processPackageJSONChange();

      case "unlink":
        return processPackageJSONUnlink();
    }
  });
}

async function processPackageJSONAdd() {
  debug("Detected package.json, initializing watcher");
  const workspaces = (watchedWorkspaces = await readWorkspaces());
  debug("Found workspaces", workspaces);
  await initWorkspaceNames(workspaces);
  workspaces.forEach(watchWorkspace);
}

async function processPackageJSONChange() {
  debug("Detected package.json change, updating watchlist");
  warn("Function not implemented: processPackageJSONChange");
  // TODO:
}

async function processPackageJSONUnlink() {
  warn("package.json has been deleted, pausing");
  warn("Function not implemented: processPackageJSONUnlink");
  // TODO:
}

async function initWorkspaceNames(workspaces: WorkspacePath[]) {
  return Promise.all(
    workspaces.map(async (workspace) => {
      try {
        const packageJSON = await readPackageJSON(packageJSONPath(workspace));
        const name = packageJSON.name as WorkspaceName;
        workspaceNames[workspace] = name;
      } catch (_error) {
        warn(
          `Workspace package.json not found, ignoring ${green(workspace)}`,
          workspace
        );
      }
    })
  );
}

async function watchWorkspace(path: WorkspacePath) {
  workspacesWatch.add(packageJSONPath(path));
}

async function readWorkspaces(): Promise<WorkspacePath[]> {
  const packageJSON = await readPackageJSON(rootPackageJSONPath);
  const workspaces = (await glob(
    packageJSON.workspaces || []
  )) as WorkspacePath[];
  return workspaces;
}

async function getBuildInfoDependencies(
  buildInfoPath: BuildInfoPath
): Promise<WorkspaceName[]> {
  const buildInfo = await withRetry(() => readBuildInfo(buildInfoPath), 50, 10);

  const workspacePath = buildInfoPathToWorkspacePath(buildInfoPath);
  const workspaceName = getWorkspaceName(workspacePath);

  const indices = getLocalBuildInfoFileIndices(buildInfo);
  const allFileNames = new Set<BuildInfoFileName>();

  for (const index of indices) {
    const listIds = getListIds(index, buildInfo);
    const listFileIds = getListsFileIds(listIds, buildInfo);
    const fileNames = getFileNames(listFileIds, buildInfo);
    fileNames.forEach((fileName) => allFileNames.add(fileName));
  }

  const deps = new Set<WorkspaceName>();

  allFileNames.forEach((buildInfoFile) => {
    const file = buildInfoFileToWorkspaceFile(buildInfoPath, buildInfoFile);
    const workspacePath = watchedWorkspaces.find((workspace) =>
      belongsToWorkspace(file, workspace)
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

function getListIds(
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

function getListsFileIds(
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

function getFileNames(
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

async function readBuildInfo(path: BuildInfoPath) {
  const content = await readFile(path, "utf-8");
  return JSON.parse(content) as BuildInfo;
}

function buildInfoFileToWorkspaceFile(
  buildInfoPath: BuildInfoPath,
  file: BuildInfoFileName
) {
  return relative(
    root,
    resolve(dirname(buildInfoPath), file)
  ) as WorkspaceFilePath;
}

function getWorkspaceName(workspacePath: WorkspacePath) {
  const name = workspaceNames[workspacePath];
  if (!name) {
    error("Internal error: workspace name not found", workspacePath);
    log(new Error().stack);
    process.exit(1);
  }
  return name;
}

function getWorkspacePath(workspaceName: WorkspaceName) {
  const path = Object.entries(workspaceNames).find(
    ([, name]) => name === workspaceName
  )?.[0];
  if (!path) {
    error("Internal error: workspace path not found", workspaceName);
    log(new Error().stack);
    process.exit(1);
  }
  return path as WorkspacePath;
}

function belongsToWorkspace(file: WorkspaceFilePath, workspace: WorkspacePath) {
  return file.startsWith(workspace);
}

async function readPackageJSON(path: PackageJSONPath) {
  const content = await readFile(path, "utf-8");
  return JSON.parse(content) as PackageJSON;
}

function getWorkspaceDependencies(workspaceName: WorkspaceName) {
  const workspaceDeps = workspaceDependencies[workspaceName];
  if (!workspaceDeps) {
    error("Internal error: workspace dependencies not found", workspaceName);
    log(new Error().stack);
    process.exit(1);
  }
  return workspaceDeps;
}

function extractWorkspaceDependenciesFromPackageJSON(packageJSON: PackageJSON) {
  return extractWorkspaceDependencies(packageJSON.dependencies).concat(
    extractWorkspaceDependencies(packageJSON.devDependencies)
  );
}

function extractWorkspaceDependencies(
  dependencies: Record<WorkspaceName, string> | undefined
) {
  const names = Object.values(workspaceNames);
  const dependenciesNames = Object.keys(dependencies || {}) as WorkspaceName[];
  return dependenciesNames.filter((name) => names.includes(name));
}

function packageJSONPath(workspace: WorkspacePath) {
  return relative(root, resolve(workspace, "package.json")) as PackageJSONPath;
}

function packageJSONPathToWorkspacePath(packageJSONPath: PackageJSONPath) {
  return dirname(packageJSONPath) as WorkspacePath;
}

function relativePackageJSONPath(packageJSONPath: AbsolutePackageJSONPath) {
  return relative(root, packageJSONPath) as PackageJSONPath;
}

function relativeBuildInfoPath(buildInfoPath: AbsoluteBuildInfoPath) {
  return relative(root, buildInfoPath) as BuildInfoPath;
}

function buildWathInfoPath(workspace: WorkspacePath) {
  return relative(
    root,
    resolve(workspace, ".ts/tsconfig.tsbuildinfo")
  ) as BuildInfoPath;
}

function buildInfoPathToWorkspacePath(buildInfoPath: BuildInfoPath) {
  return relative(root, resolve(dirname(buildInfoPath), "..")) as WorkspacePath;
}

function areReferencesEqual(a: TSConfigReference[], b: TSConfigReference[]) {
  return areEqual(a.map(getReferencePath), b.map(getReferencePath));
}

function getReferencePath(reference: TSConfigReference) {
  return reference.path;
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

async function readTSConfig(path: TSConfigPath) {
  const content = await readFile(path, "utf-8");
  return JSON.parse(content) as TSConfig;
}

async function mutateTSConfig(
  tsConfigPath: TSConfigPath,
  mutator: (tsConfig: TSConfig) => boolean | void
) {
  const tsConfig = await readTSConfig(tsConfigPath);
  const skipWrite = mutator(tsConfig) === false;
  if (skipWrite) return;
  const content = await format(JSON.stringify(tsConfig), { parser: "json" });
  await writeFile(tsConfigPath, content);
}

function getTSConfigPath(workspace: WorkspacePath) {
  return relative(root, resolve(workspace, "tsconfig.json")) as TSConfigPath;
}

function getRelativeWorkspacePath(
  dependency: WorkspacePath,
  workspace?: WorkspacePath
) {
  return relative(workspace || root, dependency) as RelativeWorkspacePath;
}

function relativeWorkspacePathToWorkspacePath(
  relativePath: RelativeWorkspacePath,
  workspacePath: WorkspacePath
) {
  return relative(root, resolve(workspacePath, relativePath)) as WorkspacePath;
}

function debug(...message: any[]) {
  if (verbose) console.debug(...message);
}

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

interface BuildInfo {
  program: {
    fileNames: Record<BuildInfoFileIndex, BuildInfoFileName>;
    referencedMap?: [BuildInfoFileId, BuildInfoListId][];
    fileIdsList?: Record<BuildInfoListIndex, BuildInfoFileId[]>;
  };
}

interface PackageJSON {
  name: WorkspaceName;
  dependencies: Record<WorkspaceName, string>;
  devDependencies?: Record<WorkspaceName, string>;
  workspaces?: string[];
}

interface TSConfig {
  compilerOptions?: {
    paths?: TSConfigPaths;
  };
  files?: string[];
  references?: TSConfigReference[];
}

type TSConfigPaths = Record<
  WorkspacePathPattern,
  [RelativeWorkspacePathPattern]
>;

interface TSConfigReference {
  path: RelativeWorkspacePath;
}

type AbsolutePackageJSONPath = OpaqueString<
  typeof absolutePackageJSONPathBrand
>;
declare const absolutePackageJSONPathBrand: unique symbol;

type PackageJSONPath = OpaqueString<typeof packageJSONPathBrand>;
declare const packageJSONPathBrand: unique symbol;

type WorkspacePath = OpaqueString<typeof workspacePathBrand>;
declare const workspacePathBrand: unique symbol;

type WorkspacePathPattern = OpaqueString<typeof workspacePathPatternBrand>;
declare const workspacePathPatternBrand: unique symbol;

type RelativeWorkspacePath = OpaqueString<typeof relativeWorkspacePathBrand>;
declare const relativeWorkspacePathBrand: unique symbol;

type RelativeWorkspacePathPattern = OpaqueString<
  typeof relativeWorkspacePathPatternBrand
>;
declare const relativeWorkspacePathPatternBrand: unique symbol;

type WorkspaceName = OpaqueString<typeof workspaceNameBrand>;
declare const workspaceNameBrand: unique symbol;

type BuildInfoPath = OpaqueString<typeof buildInfoPathBrand>;
declare const buildInfoPathBrand: unique symbol;

type AbsoluteBuildInfoPath = OpaqueString<typeof absoluteBuildInfoPathBrand>;
declare const absoluteBuildInfoPathBrand: unique symbol;

type WorkspaceFilePath = OpaqueString<typeof workspaceFilePathBrand>;
declare const workspaceFilePathBrand: unique symbol;

type TSConfigPath = OpaqueString<typeof tsConfigPathBrand>;
declare const tsConfigPathBrand: unique symbol;

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
