import watcher from "@parcel/watcher";
import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { stat } from "fs/promises";
import { relative } from "path";
import picocolors from "picocolors";
import { BuildInfo } from "./buildinfo.js";
import { Package } from "./package.js";
import { State } from "./state.js";
import { TSConfig } from "./tsconfig.js";
import { Utils } from "./utils.js";
import { Workspaces } from "./workspaces.js";

const { green, gray, blue } = picocolors;

/// Main

export async function watch() {
  process.on("SIGINT", async () => {
    await watcherSubscription.unsubscribe();
    stopAllChildren();
  });

  await processRootPackageAdd();
  await startTSC();
  watcherSubscription = await startWatcher();
}

/// CLI

const showRedundant = !!process.argv.find((arg) => arg === "--redundant");

/// Processes managment

// Child processes
const children = new Set<ChildProcessWithoutNullStreams>();

function stopAllChildren() {
  children.forEach((child) => child.kill("SIGINT"));
  children.clear();
}

/// tsc

function startTSC() {
  const tscChild = spawn("tsc", ["--build", "--watch", "--pretty"], {
    cwd: State.root,
    shell: true,
  });

  children.add(tscChild);

  tscChild.stdout.on("data", (data) => {
    let output = data.toString();
    // Remove the ANSI escape sequences for clearing the screen
    output = output.replace(/\x1Bc|\x1B\[2J|\x1B\[3J/g, "");
    console.log(output);
  });

  tscChild.stderr.on("data", (data) => {
    console.log(data.toString());
  });
}

/// Watcher

//// Events processing

let watcherSubscription: watcher.AsyncSubscription;

function startWatcher() {
  return watcher.subscribe(State.root, (err, events) => {
    if (err) {
      Utils.error("Filesystem watcher error!");
      Utils.log(err);
    }

    events.forEach((event) => {
      const path = relative(State.root, event.path);

      switch (true) {
        case path === State.rootPackagePath:
          return processRootPackageWatchEvent(event);

        case !State.watching.current:
          // Paused, only process root package.json events
          return;

        case State.workspacePackagesWatchlist.has(path as Package.PackagePath):
          return processWorkspacePackageWatchEvent(
            event,
            path as Package.PackagePath
          );

        case State.buildInfoWatchlist.has(path as BuildInfo.BuildInfoPath):
          return processBuildInfoWatchEvent(
            event,
            path as BuildInfo.BuildInfoPath
          );
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
  packagePath: Package.PackagePath
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
  buildInfoPath: BuildInfo.BuildInfoPath
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

function watchWorkspacePackage(workspacePath: Workspaces.WorkspacePath) {
  Utils.debug("Watching workspace", workspacePath);
  const packagePath = Package.getWorkspacePackagePath(workspacePath);
  State.workspacePackagesWatchlist.add(packagePath);
  return processWorkspacePackageCreate(packagePath);
  // TODO: Get rid of it?!
  // return stat(packagePath)
  //   .catch(() => {})
  //   .then((stats) => stats && processWorkspacePackageCreate(packagePath));
}

async function watchBuildInfo(workspacePath: Workspaces.WorkspacePath) {
  const buildInfoPath = BuildInfo.getBuildInfoPath(workspacePath);
  if (State.buildInfoWatchlist.has(buildInfoPath)) return;

  Utils.debug("Watching build info", workspacePath, buildInfoPath);

  // Add to the watchlist
  State.buildInfoWatchlist.add(buildInfoPath);

  // Start processing create if the build info is already there
  await stat(buildInfoPath)
    .catch(() => {})
    .then<any>((stats) => stats && processBuildInfoCreate(buildInfoPath));
}

//// Root package.json events processing

async function processRootPackageAdd() {
  const rootPackage = await Package.readPackage(State.rootPackagePath).catch(
    () =>
      Utils.warn(
        "package.json not found, make sure you are in the root directory. The processing will begine once the file is created."
      )
  );
  if (!rootPackage) return;

  return processRootPackageCreate(rootPackage);
}

async function processRootPackageCreate(argPackage?: Package.Package) {
  Utils.debug("Detected package.json create, initializing processing");

  // Use already read package.json if provided or read it
  const rootPackage =
    argPackage || (await Package.readPackage(State.rootPackagePath));

  // Find all workspaces on the filesystem using the package globs
  const workspacePaths = await Workspaces.workspacesFromPackage(rootPackage);
  Utils.debug("Found workspaces", workspacePaths);

  // Before doing anything, we need to parse packages, save which workspaces
  // have missing package.json and store the workspace names, so they are
  // always available for the rest of the processing
  await Package.readPackages(workspacePaths);

  // Now read the tsconfig.json files and store the config presence. We need it
  // so we can know which workspaces to ignore.
  await TSConfig.readTSConfigs(workspacePaths);

  // Now remove all workspaces without package.json and tsconfig.json and start
  // watching the rest.
  const matchingWorkspacePaths = Workspaces.matchingWorkspaces(workspacePaths);

  Utils.debug("Mathcing workspaces", matchingWorkspacePaths);

  // Update the workspace tsconfig.json files with proper config if necessary
  await TSConfig.configureTSConfigs(matchingWorkspacePaths);

  // Setup the root config from workspaces if necessary
  await TSConfig.configureRoot(matchingWorkspacePaths);

  return Promise.all(
    Array.from(matchingWorkspacePaths).map(watchWorkspacePackage)
  );
}

async function processRootPackageChange() {
  Utils.debug("Detected package.json change, updating watchlist");

  // Unpause the processing if paused
  State.watch();

  // Read the package
  const rootPackage = await Package.readPackage(State.rootPackagePath);

  // Find all workspaces on the filesystem using the package globs
  const workspacePaths = await Workspaces.workspacesFromPackage(rootPackage);
  Utils.debug("Found workspaces", workspacePaths);

  // Now check if the workspaces list has changed
  const watchedWorkspaces = Workspaces.getWatchedWorkspacePaths();
  if (Utils.areSetsEqual(workspacePaths, watchedWorkspaces)) {
    Utils.debug("Workspaces list unchanged, skipping");
    return;
  }

  // Find the missing and redundant workspaces
  const missingWorkspaces = Utils.getSetMissingItems(
    watchedWorkspaces,
    workspacePaths
  );
  const redundantWorkspaces = Utils.getSetRedundantItems(
    watchedWorkspaces,
    workspacePaths
  );
  Utils.log(
    `Workspaces list updated, ${
      missingWorkspaces.size
        ? `added: ${Array.from(missingWorkspaces).map(green).join(", ")}` +
          (redundantWorkspaces.size ? "; " : "")
        : ""
    }${
      redundantWorkspaces.size
        ? `removed: ${Array.from(redundantWorkspaces).map(gray).join(", ")}`
        : ""
    }; processing`
  );

  // Remove redundant workspaces
  redundantWorkspaces.forEach((workspacePath) => {
    // Update the watchlists
    State.workspacePackagesWatchlist.delete(
      Package.getWorkspacePackagePath(workspacePath)
    );
    State.buildInfoWatchlist.delete(BuildInfo.getBuildInfoPath(workspacePath));
    // Clean up the workspace links
    State.workspaceDependencies.delete(
      Workspaces.getWorkspaceName(workspacePath)
    );
    State.workspaceNames.delete(workspacePath);
  });

  // Read missing workspaces package.json and assign the names
  await Package.readPackages(missingWorkspaces);

  // Read missing workspaces tsconfig.json and assign the config presence
  await TSConfig.readTSConfigs(missingWorkspaces);

  // Now remove all workspaces without package.json and tsconfig.json and start
  // watching the rest.
  const matchingWorkspacePaths = Workspaces.matchingWorkspaces(workspacePaths);

  // Watch all missing packages
  matchingWorkspacePaths.forEach(watchWorkspacePackage);
}

async function processRootPackageDelete() {
  Utils.warn("package.json has been deleted, pausing processing");
  State.pause();
}

//// Workspace package.json events processing

function processWorkspacePackageCreate(packagePath: Package.PackagePath) {
  return processWorkspacePackageWrite(packagePath, true);
}

async function processWorkspacePackageUpdate(packagePath: Package.PackagePath) {
  return processWorkspacePackageWrite(packagePath);
}

async function processWorkspacePackageWrite(
  packagePath: Package.PackagePath,
  create?: boolean
) {
  Utils.debug(
    `Detected workspace package.json ${create ? "create" : "update"}`,
    packagePath
  );

  // Get the workspace path
  const workspacePath = Package.packagePathToWorkspacePath(packagePath);

  // Mark that the package is not missing anymore
  if (create)
    Workspaces.addRequirement(workspacePath, Workspaces.Requirement.Package);

  // Store the previous name
  const prevName = !create && Workspaces.getWorkspaceName(workspacePath);

  // Read the workspace package.json
  const pkg = await Package.readPackage(packagePath);
  // Parse the dependencies
  const dependencies = Package.getPackageDependencies(pkg);
  // Extract the name
  const workspaceName = pkg.name;
  Utils.debug("Found workspace dependencies", workspaceName, dependencies);

  if (workspaceName) {
    // Assign the workspace name
    State.workspaceNames.set(workspacePath, workspaceName);
    Workspaces.addRequirement(
      workspacePath,
      Workspaces.Requirement.PackageName
    );

    // If not create (no prev name) and the name has changed...
    if (prevName && prevName !== workspaceName) {
      // Copy the dependencies from the previous name
      const prevDeps = Workspaces.getWorkspaceDependencies(prevName);
      // Set the dependencies for the new name
      State.workspaceDependencies.set(workspaceName, prevDeps);
      // Remove the dependencies for the previous name
      State.workspaceDependencies.delete(prevName);
    }

    // If just created and the build info dependencies are not there then set
    // them to the package dependencies
    create && State.workspaceDependencies.set(workspaceName, dependencies);

    // If the name has changed
    if (prevName && prevName !== workspaceName) {
      Utils.log(
        `Workspace name changed ${prevName} → ${workspaceName}, updating the references`
      );
      // Update the references
      await Workspaces.renameWorkspaceReferences(prevName, workspaceName);
    }
  } else {
    // Remove the workspace name
    State.workspaceNames.delete(workspacePath);
    prevName && State.workspaceDependencies.delete(prevName);
    Workspaces.removeRequirement(
      workspacePath,
      Workspaces.Requirement.PackageName
    );
  }

  // Ensure the we're watching the buildinfo:
  return watchBuildInfo(workspacePath);
}

async function processWorkspacePackageDelete(packagePath: Package.PackagePath) {
  Utils.debug("Detected workspace package.json unlink, TODO:", packagePath);
  Utils.warn("Function not implemented: processWorkspaceUnlink", packagePath);
  // TODO:
}

//// Build info events processing

async function processBuildInfoCreate(buildInfoPath: BuildInfo.BuildInfoPath) {
  return processBuildInfoWrite(buildInfoPath, true);
}

async function processBuildInfoUpdate(buildInfoPath: BuildInfo.BuildInfoPath) {
  return processBuildInfoWrite(buildInfoPath, false);
}

async function processBuildInfoWrite(
  buildInfoPath: BuildInfo.BuildInfoPath,
  create?: boolean
) {
  Utils.debug(`Detected build ${create ? "create" : "update"}`, buildInfoPath);

  const workspacePath = BuildInfo.buildInfoPathToWorkspacePath(buildInfoPath);
  const workspaceName = Workspaces.getWorkspaceName(workspacePath);

  // Check if the build info is back
  if (create && State.missingBuildInfos.has(buildInfoPath)) {
    State.missingBuildInfos.delete(buildInfoPath);
    Utils.log(
      `The ${blue(
        workspaceName
      )} tsconfig.tsbuildinfo has been created, resuming processing`
    );
  }

  // Try to read the build info dependencies. TypeScript writes in chunks so
  // we might read broken JSON and retry a few times. If it fails,
  // we'll try again on the next write.
  let buildInfoDeps: Workspaces.WorkspaceName[];
  try {
    buildInfoDeps = await BuildInfo.getBuildInfoDependencies(buildInfoPath);
  } catch (err) {
    Utils.error("Failed to get build info dependencies", buildInfoPath);
    Utils.log(err);
    return;
  }

  Utils.debug("Found build info dependencies", buildInfoPath, buildInfoDeps);

  const workspaceDeps = Workspaces.getWorkspaceDependencies(workspaceName);
  const missing = Utils.getMissingItems(workspaceDeps, buildInfoDeps);
  const redundant = Utils.getRedundantItems(workspaceDeps, buildInfoDeps);

  // If the CLI arg is set, show the redundant dependencies
  if (showRedundant && redundant.length) {
    const command = `npm uninstall -w ${workspaceName} ${redundant
      .map((name) => name + "@*")
      .join(" ")}`;

    if (!State.commandsReported.has(command)) {
      State.commandsReported.add(command);

      Utils.warn(
        `Detected redundant dependencies in ${green(
          workspaceName
        )} package.json:`,
        gray(redundant.join(", "))
      );

      Utils.log(
        `${gray("Please run")}:
    
    ${blue(command)}`
      );
    }
  }

  // If there are missing dependencies, write to the log with debounce
  if (missing.length)
    Utils.debouncedLog(
      `Dependencies changed, run the command to update package-lock.json:

    ${blue(`npm install`)}`
    );

  // Update the workspace dependencies with the build info dependencies
  State.workspaceDependencies.set(workspaceName, buildInfoDeps);

  return Promise.all([
    // Add missing dependencies to the package.json
    missing.length && Package.addMissingDependencies(workspacePath, missing),

    // Update the references in the tsconfig.json
    TSConfig.updateReferences(workspacePath, buildInfoDeps),
  ]);
}

function processBuildInfoDelete(buildInfoPath: BuildInfo.BuildInfoPath) {
  Utils.debug("Detected build info unlink", buildInfoPath);

  const workspacePath = BuildInfo.buildInfoPathToWorkspacePath(buildInfoPath);
  const workspaceName = Workspaces.getWorkspaceName(workspacePath);

  Utils.warn(
    `The ${blue(
      workspaceName
    )} tsconfig.tsbuildinfo has been deleted, pausing processing`
  );

  State.missingBuildInfos.add(buildInfoPath);
}
