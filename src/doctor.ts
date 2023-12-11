import { glob } from "glob";
import picocolors from "picocolors";
import { Package } from "./package.js";
import { State } from "./state.js";
import { TSConfig } from "./tsconfig.js";
import { Utils } from "./utils.js";
import { Workspaces } from "./workspaces.js";

const { green, gray, blue, bold, red, yellow } = picocolors;

/// Main

export async function doctor() {
  const rootPackage = await checkRootPackage();
  await checkWorkspacesWithRootTSConfig(rootPackage);
}

/// CLI

const fix = !!process.argv.find((arg) => arg === "--fix");

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
        `    ${yellow(
          "●"
        )} The workspace is empty, consider removing it: ${gray(
          `rm -rf ${report.path}\n`
        )}`
      );
      return;
    }

    report.checks.forEach((check) => printCheck(check.status, check.message));

    Utils.print("\n");
  });

  const rootOk = await checkRootTSConfig(workspacePaths);
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
      `${red("►")} To automatically fix the failing issues, run:\n\n    ${gray(
        `npx tsrf doctor --fix`
      )}`
    );
  }

  if (rootOk && !redundantWorkspaces.length && !anyIssues) {
    Utils.log(`${green("►")} All is OK!`);
  }
}

const globIgnore = ["**/node_modules/**", "**/.ts/**"];

async function checkWorkspace(
  workspacePath: Workspaces.WorkspacePath
): Promise<Report> {
  const report: Report = {
    name: undefined,
    path: workspacePath,
    checks: [],
  };

  const ok = (message: string) => report.checks.push({ status: "ok", message });
  const fail = (message: string) =>
    report.checks.push({ status: "fail", message });
  const info = (message: string) =>
    report.checks.push({ status: "info", message });

  const packagePath = Package.getWorkspacePackagePath(workspacePath);
  const pkg = await Package.readPackage(packagePath).catch(() => {});

  if (pkg) ok("package.json");
  else fail(`package.json not found or it's invalid`);

  if (pkg && !pkg.name) fail(`name in package.json is empty or missing`);

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

    if (tsConfig) info("no TS files found, but tsconfig.json exists");
    else info(`no TS files found`);

    return report;
  }

  if (!tsConfig) {
    fail(`tsconfig.json not found or it's invalid`);
    return report;
  }

  if (
    !TSConfig.isCompilerOptionsSatisfactory(
      tsConfig?.compilerOptions,
      TSConfig.defaultTSConfigCompilerOptions
    )
  ) {
    fail(`tsconfig.json needs to be configured`);
    return report;
  }

  ok(`tsconfig.json`);

  return report;
}

async function checkRootTSConfig(
  workspacePaths: Set<Workspaces.WorkspacePath>
): Promise<boolean> {
  Utils.print(`${blue("Project root")}:\n`);

  printCheck("ok", "package.json");

  const tsConfig = await TSConfig.readTSConfig(State.rootTSConfigPath).catch(
    () => {}
  );

  if (!tsConfig) {
    printCheck("fail", "tsconfig.json not found or it's invalid");
    return false;
  }
  const references = TSConfig.referencesFromWorkspacePaths(workspacePaths);

  if (!TSConfig.isRootTSConfigSatisfactory(tsConfig, references)) {
    printCheck("fail", "tsconfig.json needs to be configured");
    return false;
  }

  printCheck("ok", "tsconfig.json");

  return true;
}

/// Utils

function printCheck(status: CheckStatus, message: string) {
  const statusStr =
    status === "ok"
      ? green("OK")
      : status === "info"
        ? yellow("OK")
        : bold(red("FAIL"));

  const bullet =
    status === "ok" ? green("○") : status === "info" ? yellow("●") : red("●");

  Utils.print(`    ${bullet} ${message}: ${statusStr}`);
}

/// Types

type CheckStatus = "ok" | "fail" | "info";

interface Report {
  name: Workspaces.WorkspaceName | undefined;
  path: Workspaces.WorkspacePath;
  checks: ReportCheck[];
  redundant?: boolean;
}

type ReportCheck = ReportCheckOk | ReportCheckFail;

interface ReportCheckOk {
  status: "ok" | "info";
  message: string;
}

interface ReportCheckFail {
  status: "fail";
  message: string;
  fix?: () => {};
}
