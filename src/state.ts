import { BuildInfo } from "./buildinfo.js";
import { Package } from "./package.js";
import { Workspaces } from "./workspaces.js";

export namespace State {
  // Constants

  export const root = process.cwd();
  export const rootPackagePath = "package.json" as Package.PackagePath;

  // State
  export const missingPackages = new Set<Workspaces.WorkspacePath>();

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
}
