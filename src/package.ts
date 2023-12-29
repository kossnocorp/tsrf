import { OpaqueString } from "typeroo/string/index.js";
import { Workspaces } from "./workspaces.js";
import { Utils } from "./utils.js";
import { dirname, relative, resolve } from "path";
import { readFile, writeFile } from "fs/promises";
import { format } from "prettier";
import picocolors from "picocolors";
import { State } from "./state.js";

const { green, blue } = picocolors;

export namespace Package {
  /// Types

  export interface Package {
    name?: Workspaces.WorkspaceName | undefined;
    dependencies?: PackageDependencies;
    devDependencies?: Record<Workspaces.WorkspaceName, string>;
    workspaces?: string[];
  }

  export type PackageDependencies = Record<Workspaces.WorkspaceName, string>;

  export type PackagePath = OpaqueString<typeof packagePathBrand>;
  declare const packagePathBrand: unique symbol;

  /// Functions

  export async function readPackages(
    workspacePaths: Set<Workspaces.WorkspacePath>
  ) {
    const namesResults = await Promise.all(
      Array.from(workspacePaths).map(async (workspacePath) => {
        const pkg = await readPackage(
          getWorkspacePackagePath(workspacePath)
        ).catch(() => {});

        if (pkg?.name) {
          Workspaces.addRequirement(
            workspacePath,
            Workspaces.Requirement.Package | Workspaces.Requirement.PackageName
          );
          return [workspacePath, pkg.name] as const;
        }

        if (pkg && !pkg.name) {
          Utils.warn(
            `Workspace package.json name is missing, ignoring ${green(
              workspacePath
            )}`,
            workspacePath
          );

          Workspaces.addRequirement(
            workspacePath,
            Workspaces.Requirement.Package
          );

          Workspaces.removeRequirement(
            workspacePath,
            Workspaces.Requirement.PackageName
          );
        } else {
          Utils.warn(
            `Workspace package.json not found, ignoring ${green(
              workspacePath
            )}`,
            workspacePath
          );

          Workspaces.removeRequirement(
            workspacePath,
            Workspaces.Requirement.Package | Workspaces.Requirement.PackageName
          );
        }
      })
    );

    namesResults.forEach(
      (nameResult) => nameResult && State.workspaceNames.set(...nameResult)
    );
  }

  export async function readPackage(packagePath: PackagePath) {
    const content = await readFile(packagePath, "utf-8");
    return JSON.parse(content) as Package;
  }

  export function getPackageDependencies(pkg: Package) {
    return packageDependenciesToWorkspaceNames(pkg.dependencies).concat(
      packageDependenciesToWorkspaceNames(pkg.devDependencies)
    );
  }

  function packageDependenciesToWorkspaceNames(
    dependencies: Record<Workspaces.WorkspaceName, string> | undefined
  ) {
    const names = Array.from(State.workspaceNames.values());
    const dependenciesNames = Object.keys(
      dependencies || {}
    ) as Workspaces.WorkspaceName[];
    return dependenciesNames.filter((name) => names.includes(name));
  }

  export function getWorkspacePackagePath(
    workspacePath: Workspaces.WorkspacePath
  ) {
    return relative(
      State.root,
      resolve(workspacePath, "package.json")
    ) as PackagePath;
  }

  export function packagePathToWorkspacePath(packagePath: PackagePath) {
    return dirname(packagePath) as Workspaces.WorkspacePath;
  }

  export async function mutatePackage(
    packagePath: PackagePath,
    mutator: (pkg: Package) => boolean | Array<boolean | void> | void
  ) {
    const pkg = await readPackage(packagePath);

    const mutatorResult = mutator(pkg);
    const skipWrite = Array.isArray(mutatorResult)
      ? mutatorResult.every((result) => result === false)
      : mutatorResult === false;
    if (skipWrite) return;

    const content = await format(JSON.stringify(pkg, null, 2), {
      parser: "json",
    });
    await writeFile(packagePath, content);
  }

  export interface AddMissingDependenciesProps {
    missing: Workspaces.WorkspaceName[];
    redundant: Workspaces.WorkspaceName[];
  }

  export function updateChangedDependencies(
    workspacePath: Workspaces.WorkspacePath,
    { missing, redundant }: AddMissingDependenciesProps
  ) {
    return mutatePackage(getWorkspacePackagePath(workspacePath), (pkg) => {
      Utils.log(
        `The ${green(Workspaces.getWorkspaceName(workspacePath))} ${blue(
          "package.json"
        )} dependencies changed, writing`
      );

      pkg.dependencies = pkg.dependencies || {};

      missing.reduce((deps, name) => {
        deps[name] = "*";
        return deps;
      }, pkg.dependencies);

      redundant.forEach((name) => {
        delete pkg.dependencies?.[name];
        delete pkg.devDependencies?.[name];
      });

      pkg.dependencies = Utils.sortObject(pkg.dependencies);

      if (pkg.devDependencies)
        pkg.devDependencies = Utils.sortObject(pkg.devDependencies);
    });
  }
}
