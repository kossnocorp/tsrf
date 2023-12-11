import { glob } from "glob";
import picocolors from "picocolors";
import { Package } from "./package.js";
import { State } from "./state.js";
import { TSConfig } from "./tsconfig.js";
import { Utils } from "./utils.js";
import { Workspaces } from "./workspaces.js";

const { green, gray, blue, bold, red, yellow, cyan, italic } = picocolors;

/// Main

export async function doctor() {
  Utils.print("");
  Utils.log(
    italic(
      "tsrf doctor checks if the project is configured correctly and ready to be used with TypeScript Project References. It checks each workspace and the root project. In case of any issues, it prints them and exits with code 1."
    )
  );

  const rootPackage = await checkRootPackage();
  await checkWorkspacesWithRootTSConfig(rootPackage);
}

/// CLI

const fix = !!process.argv.find((arg) => arg === "--fix");
const doDelete = !!process.argv.find((arg) => arg === "--delete");

/// Checks

async function checkRootPackage() {
  const rootPackage = await Package.readPackage(State.rootPackagePath).catch(
    () => {
      Utils.error(
        "The root package.json please change the directory or create the package.json with workspaces"
      );
      process.exit(1);
    }
  );

  if (!rootPackage.workspaces) {
    Utils.error(
      "The root package.json workspaces field is missing please add it. See: https://docs.npmjs.com/cli/using-npm/workspaces"
    );
    process.exit(1);
  }

  return rootPackage;
}

async function checkWorkspacesWithRootTSConfig(rootPackage: Package.Package) {
  const workspacePaths = await Workspaces.workspacesFromPackage(rootPackage);

  if (!workspacePaths.size) {
    Utils.error(
      "Can't find any workspaces specified in the root package.json, please make sure it configuered correctly"
    );
    process.exit(1);
  }

  Utils.log(`Found ${workspacePaths.size} workspaces, checking them...`);

  const reports = await Promise.all(
    Array.from(workspacePaths).map(checkWorkspace)
  );

  reports.forEach((report) => {
    Utils.print(`Workspace ${bold(green(report.path))}:\n`);

    if (report.redundant) {
      Utils.print(
        `    ${printBullet(
          "info"
        )} The workspace is empty, consider removing it: ${gray(
          `rm -rf ${report.path}\n`
        )}`
      );
      return;
    }

    report.checks.forEach(printCheck);

    Utils.print("\n");
  });

  const rootReport = await checkRootTSConfig(workspacePaths);

  Utils.print(`${blue("Project root")}:\n`);
  rootReport.checks.forEach(printCheck);
  Utils.print("\n");

  const redundantWorkspaces = reports.filter((report) => report.redundant);

  if (redundantWorkspaces.length) {
    Utils.print(
      `${yellow(
        "►"
      )} The project contains redundant workspaces, consider removing them:\n\n    ${gray(
        `rm -rf ${redundantWorkspaces.map((report) => report.path).join(" ")}`
      )}\n`
    );
  }

  const anyIssues = reports.some((report) =>
    report.checks.some((check) => check.status === "fail")
  );

  if (!fix && anyIssues) {
    Utils.log(
      `${red("►")} To automatically fix the failing issues, run:\n\n    ${cyan(
        `npx tsrf doctor --fix`
      )}${
        redundantWorkspaces.length
          ? `\n\n...you can also add --delete to remove redundant workspaces:\n\n    ${gray(
              `npx tsrf doctor --fix --delete`
            )}`
          : ""
      }`
    );
  }

  if (rootReport && !redundantWorkspaces.length && !anyIssues) {
    Utils.log(
      `${green(
        "►"
      )} Everything is OK! You can start the watch mode now:\n\n    ${cyan(
        "npx tsrf"
      )}`
    );
    process.exit(0);
  }

  process.exit(1);
}

const globIgnore = ["**/node_modules/**", "**/.ts/**"];

async function checkWorkspace(
  workspacePath: Workspaces.WorkspacePath
): Promise<WorkspaceReport> {
  const report: WorkspaceReport = {
    name: undefined,
    path: workspacePath,
    checks: [],
  };

  const packagePath = Package.getWorkspacePackagePath(workspacePath);
  const pkg = await Package.readPackage(packagePath).catch(() => {});

  if (pkg) okCheck(report, "package.json");
  else failCheck(report, `package.json not found or it's invalid`);

  if (pkg && !pkg.name)
    failCheck(report, `name in package.json is empty or missing`);

  report.name = pkg?.name;

  const tsConfigPath = TSConfig.getTSConfigPath(workspacePath);
  const tsConfig = await TSConfig.readTSConfig(tsConfigPath).catch(() => {});

  const tsFiles = await glob(`${workspacePath}/**/*.{ts,tsx}`, {
    ignore: globIgnore,
  });

  if (!tsFiles.length) {
    if (!pkg) {
      const anyFiles = await glob(`${workspacePath}/**/*`, {
        ignore: globIgnore,
      });

      if (!anyFiles.length) {
        report.redundant = true;
        return report;
      }
    }

    if (tsConfig)
      infoCheck(report, "no TS files found, but tsconfig.json exists");
    else infoCheck(report, `no TS files found`);

    return report;
  }

  if (!tsConfig) {
    failCheck(report, `tsconfig.json not found or it's invalid`);
    return report;
  }

  if (
    !TSConfig.isCompilerOptionsSatisfactory(
      tsConfig?.compilerOptions,
      TSConfig.defaultTSConfigCompilerOptions
    )
  ) {
    failCheck(report, `tsconfig.json needs to be configured`);
    return report;
  }

  okCheck(report, `tsconfig.json`);

  return report;
}

async function checkRootTSConfig(
  workspacePaths: Set<Workspaces.WorkspacePath>
): Promise<Report> {
  const report: Report = { checks: [] };

  okCheck(report, "package.json");

  const tsConfig = await TSConfig.readTSConfig(State.rootTSConfigPath).catch(
    () => {}
  );

  if (!tsConfig) {
    failCheck(report, "tsconfig.json not found or it's invalid");
    return report;
  }
  const references = TSConfig.referencesFromWorkspacePaths(workspacePaths);

  if (!TSConfig.isRootTSConfigSatisfactory(tsConfig, references)) {
    failCheck(report, "tsconfig.json needs to be configured");
    return report;
  }

  okCheck(report, "tsconfig.json");

  return report;
}

/// Utils

function okCheck(report: Report, message: string) {
  report.checks.push({ status: "ok", message });
}

function failCheck(report: Report, message: string) {
  report.checks.push({ status: "fail", message });
}

function infoCheck(report: Report, message: string) {
  report.checks.push({ status: "info", message });
}

function printCheck(check: Check) {
  Utils.print(
    `    ${printBullet(check.status)} ${check.message}: ${printStatus(
      check.status
    )}`
  );
}

function printStatus(status: CheckStatus): string {
  switch (status) {
    case "ok":
      return green("OK");
    case "info":
      return yellow("OK");
    case "fail":
      return bold(red("FAIL"));
  }
}

function printBullet(status: CheckStatus): string {
  switch (status) {
    case "ok":
      return green("○");
    case "info":
      return yellow("●");
    case "fail":
      return red("●");
  }
}

/// Types

interface Report {
  checks: Check[];
}

interface WorkspaceReport extends Report {
  name: Workspaces.WorkspaceName | undefined;
  path: Workspaces.WorkspacePath;
  redundant?: boolean;
}

interface Check {
  status: CheckStatus;
  message: string;
}

type CheckStatus = "ok" | "fail" | "info";
