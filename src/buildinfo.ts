import { readFile } from "fs/promises";
import { dirname, relative, resolve } from "path";
import { OpaqueNumber } from "typeroo/number/index.js";
import { OpaqueString } from "typeroo/string/index.js";
import { Workspaces } from "./workspaces.js";
import { Utils } from "./utils.js";
import { State } from "./state.js";

export namespace BuildInfo {
  /// Types

  export interface BuildInfo {
    program: {
      fileNames: Record<BuildInfoFileIndex, BuildInfoFileName>;
      referencedMap?: [BuildInfoFileId, BuildInfoListId][];
      fileIdsList?: Record<BuildInfoListIndex, BuildInfoFileId[]>;
    };
  }

  export type BuildInfoPath = OpaqueString<typeof buildInfoPathBrand>;
  declare const buildInfoPathBrand: unique symbol;

  export type BuildInfoFileId = OpaqueNumber<typeof buildInfoFileIdBrand>;
  declare const buildInfoFileIdBrand: unique symbol;

  export type BuildInfoFileIndex = OpaqueNumber<typeof buildInfoFileIndexBrand>;
  declare const buildInfoFileIndexBrand: unique symbol;

  export type BuildInfoFileName = OpaqueString<typeof buildInfoFileNameBrand>;
  declare const buildInfoFileNameBrand: unique symbol;

  export type BuildInfoListId = OpaqueNumber<typeof buildInfoListIdBrand>;
  declare const buildInfoListIdBrand: unique symbol;

  export type BuildInfoListIndex = OpaqueNumber<typeof buildInfoListIndexBrand>;
  declare const buildInfoListIndexBrand: unique symbol;

  /// Functions

  async function readBuildInfo(buildInfoPath: BuildInfoPath) {
    const content = await readFile(buildInfoPath, "utf-8");
    return JSON.parse(content) as BuildInfo;
  }

  function buildInfoFileToWorkspaceFile(
    buildInfoPath: BuildInfoPath,
    fileName: BuildInfoFileName
  ) {
    return relative(
      State.root,
      resolve(dirname(buildInfoPath), fileName)
    ) as Workspaces.WorkspaceFilePath;
  }

  export function getBuildInfoPath(workspacePath: Workspaces.WorkspacePath) {
    return relative(
      State.root,
      resolve(workspacePath, ".ts/tsconfig.tsbuildinfo")
    ) as BuildInfoPath;
  }

  export function buildInfoPathToWorkspacePath(buildInfoPath: BuildInfoPath) {
    return relative(
      State.root,
      resolve(dirname(buildInfoPath), "..")
    ) as Workspaces.WorkspacePath;
  }

  //// Parsing

  export async function getBuildInfoDependencies(
    buildInfoPath: BuildInfoPath
  ): Promise<Workspaces.WorkspaceName[]> {
    const buildInfo = await Utils.withRetry(
      () => readBuildInfo(buildInfoPath),
      50,
      10
    );

    const workspacePath = buildInfoPathToWorkspacePath(buildInfoPath);
    const workspaceName = Workspaces.getWorkspaceName(workspacePath);

    const indices = getLocalBuildInfoFileIndices(buildInfo);
    const allFileNames = new Set<BuildInfoFileName>();

    for (const index of indices) {
      const listIds = getBuildInfoListIds(index, buildInfo);
      const listFileIds = getBuildInfoListsFileIds(listIds, buildInfo);
      const fileNames = getBuildInfoFileNames(listFileIds, buildInfo);
      fileNames.forEach((fileName) => allFileNames.add(fileName));
    }

    const deps = new Set<Workspaces.WorkspaceName>();

    allFileNames.forEach((buildInfoFile) => {
      const file = buildInfoFileToWorkspaceFile(buildInfoPath, buildInfoFile);
      const workspacePath = Array.from(
        Workspaces.getWatchedWorkspacePaths()
      ).find((workspace) =>
        Workspaces.isFileBelongsToWorkspace(file, workspace)
      );
      if (!workspacePath) return;

      const name = Workspaces.getWorkspaceName(workspacePath);
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
}
