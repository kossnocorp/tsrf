import { BuildInfo } from "./buildinfo.js";
import { Package } from "./package.js";
import { TSConfig } from "./tsconfig.js";
import { Workspaces } from "./workspaces.js";

export namespace State {
  /// Types

  export interface Ref<Type> {
    current: Type;
  }

  /// Constants

  export const root = process.cwd();
  export const rootPackagePath = "package.json" as Package.PackagePath;
  export const rootTSConfigPath = "tsconfig.json" as TSConfig.TSConfigPath;

  // State
  export const workspaceRequirements = new Map<
    Workspaces.WorkspacePath,
    number
  >();
  export const watching: Ref<boolean> = { current: false };

  // Links
  export const workspaceNames = new Map<
    Workspaces.WorkspacePath,
    Workspaces.WorkspaceName
  >();
  export const workspaceDependencies = new Map<
    Workspaces.WorkspaceName,
    Workspaces.WorkspaceName[]
  >();

  // DX state
  export const missingBuildInfos = new Set<BuildInfo.BuildInfoPath>();
  export const commandsReported = new Set<string>();

  // Watchlists
  export const workspacePackagesWatchlist = new Set<Package.PackagePath>();
  export const buildInfoWatchlist = new Set<BuildInfo.BuildInfoPath>();

  /// Functions

  export function watch() {
    watching.current = true;
  }

  export function pause() {
    watching.current = false;
    clear();
  }

  export function clear() {
    workspaceRequirements.clear();

    workspaceNames.clear();
    workspaceDependencies.clear();

    missingBuildInfos.clear();
    commandsReported.clear();

    workspacePackagesWatchlist.clear();
    buildInfoWatchlist.clear();
  }
}
