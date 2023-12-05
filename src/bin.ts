import type { OpaqueString } from "typeroo/string";
import { watch } from "chokidar";
import { readFile, writeFile } from "fs/promises";
import { glob } from "glob";
import { dirname, relative, resolve } from "path";
import picocolors from "picocolors";
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
  const dependencies = getWorkspaceDependenciesFromPackageJSON(packageJSON);

  debug("Found workspace dependencies", name, dependencies);
  workspaceDependencies[name] = dependencies;

  watchBuildInfo(workspacePath);
}

async function processWorkspaceChange(absolutePath: AbsolutePackageJSONPath) {
  const path = relativePackageJSONPath(absolutePath);
  debug("Detected workspace package.json change, TODO:", path);

  throw new Error("Function not implemented.");
}

async function processWorkspaceUnlink(absolutePath: AbsolutePackageJSONPath) {
  const path = relativePackageJSONPath(absolutePath);
  debug("Detected workspace package.json unlink, TODO:", path);

  throw new Error("Function not implemented.");
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

async function processBuildInfoAdd(absolutePath: AbsoluteBuildInfoPath) {
  const buildInfoPath = relativeBuildInfoPath(absolutePath);
  debug("Detected build info", buildInfoPath);

  const buildInfoDependencies = await getBuildInfoDependencies(buildInfoPath);
  debug("Found build info dependencies", buildInfoPath, buildInfoDependencies);

  const workspacePath = buildInfoPathToWorkspacePath(buildInfoPath);
  const name = getWorkspaceName(workspacePath);

  const workspaceDeps = workspaceDependencies[name];
  if (!workspaceDeps) {
    error("Internal error: workspace dependencies not found", name);
    process.exit(1);
  }

  const missing = findMissingDependencies(workspaceDeps, buildInfoDependencies);
  const redundant = findRedundantDependencies(
    workspaceDeps,
    buildInfoDependencies
  );

  if (missing.length) {
    warn(
      `Detected missing dependencies in ${green(name)} package.json:`,
      gray(missing.join(", "))
    );

    log(
      `${gray("Please run")}:
    
    ${blue(
      `npm install -w ${name} ${missing.map((name) => name + "@*").join(" ")}`
    )}`
    );
  }

  if (showRedundant && redundant.length) {
    warn(
      `Detected redundant dependencies in ${green(name)} package.json:`,
      gray(redundant.join(", "))
    );

    log(
      `${gray("Please run")}:
    
    ${blue(
      `npm uninstall -w ${name} ${redundant
        .map((name) => name + "@*")
        .join(" ")}`
    )}`
    );
  }

  await mutateTSConfig(getTSConfigPath(workspacePath), (tsConfig) => {
    const references = dependeciesToReferences(
      workspacePath,
      buildInfoDependencies
    );
    const referencesUnchanged = areArraysEqual(
      references,
      tsConfig?.references || []
    );
    if (referencesUnchanged) return false;
    log(
      `Writing ${blue(
        getWorkspaceName(workspacePath)
      )} tsconfig.json with updated references list`
    );
    debug("References:", references);
  });
}

function processBuildInfoChange(absolutePath: AbsoluteBuildInfoPath) {
  const path = relativeBuildInfoPath(absolutePath);
  debug("Detected build info change", path);
  throw new Error("Function not implemented.");
}

function processBuildInfoUnlink(absolutePath: AbsoluteBuildInfoPath) {
  const path = relativeBuildInfoPath(absolutePath);
  debug("Detected build info unlink", path);
  throw new Error("Function not implemented.");
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
  await readPackageJSON(rootPackageJSONPath);
}

async function processPackageJSONUnlink() {
  warn("package.json has been deleted, pausing");
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
  const buildInfo = await readBuildInfo(buildInfoPath);
  const workspacePath = buildInfoPathToWorkspacePath(buildInfoPath);
  const workspaceName = getWorkspaceName(workspacePath);

  const deps = new Set<WorkspaceName>();

  buildInfo.program.fileNames.forEach((buildInfoFile) => {
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

async function readBuildInfo(path: BuildInfoPath) {
  const content = await readFile(path, "utf-8");
  return JSON.parse(content) as BuildInfo;
}

function buildInfoFileToWorkspaceFile(
  buildInfoPath: BuildInfoPath,
  file: BuildInfoFilePath
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

function getWorkspaceDependenciesFromPackageJSON(packageJSON: PackageJSON) {
  return getWorkspaceDependencies(packageJSON.dependencies).concat(
    getWorkspaceDependencies(packageJSON.devDependencies)
  );
}

function getWorkspaceDependencies(
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

function areArraysEqual<Type extends any>(a: Type[], b: Type[]) {
  return a.length === b.length && a.every((item) => b.includes(item));
}

function findMissingDependencies(
  actual: WorkspaceName[],
  required: WorkspaceName[]
) {
  return required.filter((item) => !actual.includes(item));
}

function findRedundantDependencies(
  actual: WorkspaceName[],
  required: WorkspaceName[]
) {
  return actual.filter((item) => !required.includes(item));
}

async function readTSConfig(path: TSConfigPath) {
  const content = await readFile(path, "utf-8");
  return JSON.parse(content) as TSConfig;
}

async function mutateTSConfig(
  path: TSConfigPath,
  mutator: (tsConfig: TSConfig) => boolean | void
) {
  const tsConfig = await readTSConfig(path);
  const skipWrite = !mutator(tsConfig);
  if (skipWrite) return;
  const content = JSON.stringify(tsConfig, null, 2);
  await writeFile(path, content);
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

interface BuildInfo {
  program: {
    fileNames: BuildInfoFilePath[];
  };
}

interface PackageJSON {
  name: WorkspaceName;
  dependencies: Record<WorkspaceName, string>;
  devDependencies?: Record<WorkspaceName, string>;
  workspaces?: string[];
}

interface TSConfig {
  files?: string[];
  references?: TSConfigReference[];
}

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

type RelativeWorkspacePath = OpaqueString<typeof relativeWorkspacePathBrand>;
declare const relativeWorkspacePathBrand: unique symbol;

type WorkspaceName = OpaqueString<typeof workspaceNameBrand>;
declare const workspaceNameBrand: unique symbol;

type BuildInfoPath = OpaqueString<typeof buildInfoPathBrand>;
declare const buildInfoPathBrand: unique symbol;

type AbsoluteBuildInfoPath = OpaqueString<typeof absoluteBuildInfoPathBrand>;
declare const absoluteBuildInfoPathBrand: unique symbol;

type WorkspaceFilePath = OpaqueString<typeof workspaceFilePathBrand>;
declare const workspaceFilePathBrand: unique symbol;

type BuildInfoFilePath = OpaqueString<typeof buildInfoFilePathBrand>;
declare const buildInfoFilePathBrand: unique symbol;

type TSConfigPath = OpaqueString<typeof tsConfigPathBrand>;
declare const tsConfigPathBrand: unique symbol;
