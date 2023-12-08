import { OpaqueString } from "typeroo/string/index.js";
import { Package } from "./package.js";
import { State } from "./state.js";
import { Utils } from "./utils.js";
import { relative, resolve } from "path";
import { TSConfig } from "./tsconfig.js";
import { glob } from "glob";
import picocolors from "picocolors";

const { green } = picocolors;

export namespace Workspaces {
  /// Types

  export type WorkspacePath = OpaqueString<typeof workspacePathBrand>;
  declare const workspacePathBrand: unique symbol;

  export type WorkspaceName = OpaqueString<typeof workspaceNameBrand>;
  declare const workspaceNameBrand: unique symbol;

  export type WorkspaceFilePath = OpaqueString<typeof workspaceFilePathBrand>;
  declare const workspaceFilePathBrand: unique symbol;

  /// Functions

  export async function readWorkspaceNames(workspacePaths: Set<WorkspacePath>) {
    const namesResults = await Promise.all(
      Array.from(workspacePaths).map(async (workspacePath) => {
        const pkg = await Package.readPackage(
          Package.getWorkspacePackagePath(workspacePath)
        ).catch(() => {});

        if (!pkg) {
          Utils.warn(
            `Workspace package.json not found, ignoring ${green(
              workspacePath
            )}`,
            workspacePath
          );
          State.missingPackages.add(workspacePath);
          return;
        }

        return [workspacePath, pkg.name] as const;
      })
    );

    namesResults.forEach(
      (nameResult) => nameResult && State.workspaceNames.set(...nameResult)
    );
  }

  export async function workspacesFromPackage(
    pkg: Package.Package
  ): Promise<Set<WorkspacePath>> {
    return new Set<WorkspacePath>(
      (await glob(pkg.workspaces || [])) as WorkspacePath[]
    );
  }

  export function workspacePathsWithPackages(
    workspacePaths: Set<WorkspacePath>
  ) {
    const withPackages = new Set<WorkspacePath>(workspacePaths);
    State.missingPackages.forEach((workspacePath) =>
      withPackages.delete(workspacePath)
    );
    return withPackages;
  }

  export function workspacePathFromReferencePath(
    referencePath: TSConfig.TSConfigReferencePath,
    workspacePath: WorkspacePath
  ) {
    return relative(
      State.root,
      resolve(workspacePath, referencePath)
    ) as WorkspacePath;
  }

  export function getWorkspaceName(workspacePath: WorkspacePath) {
    const name = State.workspaceNames.get(workspacePath);
    if (!name) {
      Utils.error("Internal error: workspace name not found", workspacePath);
      Utils.log(new Error().stack);
      process.exit(1);
    }
    return name;
  }

  export function getWorkspacePath(workspaceName: WorkspaceName) {
    const path = Array.from(State.workspaceNames).find(
      ([, name]) => name === workspaceName
    )?.[0];
    if (!path) {
      Utils.error("Internal error: workspace path not found", workspaceName);
      Utils.log(new Error().stack);
      process.exit(1);
    }
    return path as WorkspacePath;
  }

  export function isFileBelongsToWorkspace(
    filePath: WorkspaceFilePath,
    workspacePath: WorkspacePath
  ) {
    return filePath.startsWith(workspacePath);
  }

  export function getWorkspaceDependencies(workspaceName: WorkspaceName) {
    const deps = State.workspaceDependencies.get(workspaceName);
    if (!deps) {
      Utils.error(
        "Internal error: workspace dependencies not found",
        workspaceName
      );
      Utils.log(new Error().stack);
      process.exit(1);
    }
    return deps;
  }

  export function getWatchedWorkspacePaths() {
    return new Set<WorkspacePath>(
      Array.from(State.workspacePackagesWatchlist).map(
        Package.packagePathToWorkspacePath
      )
    );
  }

  export function renameWorkspaceReferences(
    prevName: WorkspaceName,
    newName: WorkspaceName
  ) {
    return Promise.all(
      Array.from(State.workspaceDependencies.entries()).map(
        ([workspaceName, workspaceDeps]) => {
          // Ignore the renamed package or if the workspace doesn't depend on it
          if (workspaceName === newName || !workspaceDeps.includes(prevName))
            return;

          const workspacePath = getWorkspacePath(workspaceName);
          return Promise.all([
            // Update the package depdenencies
            renameWorkspaceInPackageDependencies(
              workspacePath,
              prevName,
              newName
            ),
            // Update references and aliases in TS config
            TSConfig.refreshTSConfigReferencesWorkspaceRename(workspacePath),
          ]);
        }
      )
    );
  }

  function renameWorkspaceInPackageDependencies(
    workspacePath: WorkspacePath,
    prevName: WorkspaceName,
    newName: WorkspaceName
  ) {
    return Package.mutatePackage(
      Package.getWorkspacePackagePath(workspacePath),
      (pkg) => {
        if (pkg.dependencies && !pkg.devDependencies?.[prevName]) {
          delete pkg.dependencies[prevName];
          pkg.dependencies[newName] = "*";
          pkg.dependencies = Utils.sortObject(pkg.dependencies);
        }

        if (pkg.devDependencies && pkg.devDependencies[prevName]) {
          delete pkg.devDependencies[prevName];
          pkg.devDependencies[newName] = "*";
          pkg.devDependencies = Utils.sortObject(pkg.devDependencies);
        }
      }
    );
  }
}
