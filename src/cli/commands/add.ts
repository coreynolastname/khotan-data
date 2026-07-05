import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import prompts from "prompts";
import {
  getEntry,
  listComponents,
  listBlocks,
  isMultiFile,
  type ComponentEntry,
  type ComponentFile,
  type ComponentDeps,
} from "../registry.js";
import {
  resolveDrizzleSchemaDir,
  detectSingleFileSchema,
  updateDrizzleConfigSchema,
  defaultDrizzleSchemaDir,
  scaffoldDrizzleConfig,
} from "../drizzle-detect.js";
import { runInit, scaffoldCoreFiles, warnAboutWorkflowProxy } from "./init.js";
import {
  checkNpmPackages,
  checkShadcnComponents,
  installPackages,
  installShadcnComponents,
} from "../deps.js";
import { installSkills, type SkillDefinition } from "../agent-detect.js";
import { ensureWorkflowNextConfig } from "../next-config.js";
import { loadConfigOutputDir } from "../cli-api.js";

function hasSrcLayout(cwd: string): boolean {
  return fs.existsSync(path.join(cwd, "src", "app"));
}

interface CronConfigResult {
  status: "created" | "updated" | "skipped" | "unsupported";
  path: string;
  schedule: string | null;
  recommendedSchedule: string;
}

const KHOTAN_CRON_PATH = "/api/khotan/cron";
const KHOTAN_CRON_SCHEDULE = "* * * * *";

function ensureCronVercelConfig(cwd: string): CronConfigResult {
  const configPath = path.join(cwd, "vercel.json");
  const cronEntry = {
    path: KHOTAN_CRON_PATH,
    schedule: KHOTAN_CRON_SCHEDULE,
  };

  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(
      configPath,
      `${JSON.stringify({ crons: [cronEntry] }, null, 2)}\n`,
      "utf-8",
    );
    return {
      status: "created",
      path: configPath,
      schedule: cronEntry.schedule,
      recommendedSchedule: KHOTAN_CRON_SCHEDULE,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return {
      status: "unsupported",
      path: configPath,
      schedule: null,
      recommendedSchedule: KHOTAN_CRON_SCHEDULE,
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      status: "unsupported",
      path: configPath,
      schedule: null,
      recommendedSchedule: KHOTAN_CRON_SCHEDULE,
    };
  }

  const config = parsed as Record<string, unknown>;
  if (config["crons"] !== undefined && !Array.isArray(config["crons"])) {
    return {
      status: "unsupported",
      path: configPath,
      schedule: null,
      recommendedSchedule: KHOTAN_CRON_SCHEDULE,
    };
  }

  const crons = (config["crons"] as unknown[] | undefined) ?? [];
  const existingCron = crons.find(
    (entry) =>
      Boolean(entry) &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      (entry as Record<string, unknown>)["path"] === cronEntry.path,
  );
  if (existingCron && typeof existingCron === "object") {
    const existingSchedule = (existingCron as Record<string, unknown>)[
      "schedule"
    ];
    return {
      status: "skipped",
      path: configPath,
      schedule: typeof existingSchedule === "string" ? existingSchedule : null,
      recommendedSchedule: KHOTAN_CRON_SCHEDULE,
    };
  }

  config["crons"] = [...crons, cronEntry];
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  return {
    status: "updated",
    path: configPath,
    schedule: cronEntry.schedule,
    recommendedSchedule: KHOTAN_CRON_SCHEDULE,
  };
}

function resolveOutputBase(
  file: ComponentFile,
  cwd: string,
  outputDir: string,
): string {
  switch (file.outputBase) {
    case "components":
      return path.resolve(
        cwd,
        hasSrcLayout(cwd) ? "src/components/khotan" : "components/khotan",
      );
    case "app":
      return path.resolve(
        cwd,
        hasSrcLayout(cwd)
          ? "src/app/api/khotan/[...all]"
          : "app/api/khotan/[...all]",
      );
    case "appRoot":
      return path.resolve(cwd, hasSrcLayout(cwd) ? "src/app" : "app");
    case "lib":
      return path.resolve(cwd, hasSrcLayout(cwd) ? "src/lib" : "lib");
    case "projectRoot":
      return path.resolve(cwd);
    case "outputDir":
    default:
      return path.resolve(cwd, outputDir);
  }
}

/**
 * Check whether a component is already scaffolded. For multi-file components,
 * require ALL files to be present — a partial scaffold means the component is
 * incomplete and should be re-scaffolded.
 */
function isScaffolded(
  entry: ComponentEntry,
  cwd: string,
  outputDir: string,
): boolean {
  if (isMultiFile(entry)) {
    return entry.files.every((f) => {
      const base = resolveOutputBase(f, cwd, outputDir);
      return fs.existsSync(path.join(base, f.outputFile));
    });
  }
  if (entry.outputFile) {
    return fs.existsSync(path.join(cwd, outputDir, entry.outputFile));
  }
  return false;
}

function wireAuthHook(cwd: string, outputDir: string): boolean {
  const khotanConfigPath = path.join(path.resolve(cwd, outputDir), "khotan.ts");
  if (!fs.existsSync(khotanConfigPath)) {
    console.warn(
      "⚠ Could not wire auth automatically: khotan.ts was not found.",
    );
    return false;
  }

  const content = fs.readFileSync(khotanConfigPath, "utf-8");
  const hasAuthImport =
    /^import \{ authorizeKhotanRequest \} from "@\/lib\/auth";$/m.test(content);
  const hasWiredAuthorize =
    /^\s*authorize\s*:\s*authorizeKhotanRequest\s*,?$/m.test(content);
  if (hasAuthImport && hasWiredAuthorize) {
    console.log("✓ khotan.ts already imports authorizeKhotanRequest");
    return false;
  }
  if (/^\s*authorize\s*:/m.test(content)) {
    console.warn(
      "⚠ khotan.ts already has an authorize property. Leaving it unchanged.",
    );
    return false;
  }

  let updated = content;
  const factoryImport =
    'import { khotan, drizzleAdapter } from "khotan-data/factory";\n';
  if (!hasAuthImport && updated.includes(factoryImport)) {
    updated = updated.replace(
      factoryImport,
      (match) =>
        `${match}import { authorizeKhotanRequest } from "@/lib/auth";\n`,
    );
  } else if (!hasAuthImport) {
    updated = `import { authorizeKhotanRequest } from "@/lib/auth";\n${updated}`;
  }

  const adapterLine = "  adapter: drizzleAdapter(db),";
  if (updated.includes(adapterLine)) {
    updated = updated.replace(
      adapterLine,
      `${adapterLine}\n  authorize: authorizeKhotanRequest,`,
    );
  } else {
    const factoryCall = "khotan({";
    updated = updated.replace(
      factoryCall,
      `${factoryCall}\n  authorize: authorizeKhotanRequest,`,
    );
  }

  fs.writeFileSync(khotanConfigPath, updated, "utf-8");
  console.log(
    `✓ Wired authorize hook in ${path.relative(cwd, khotanConfigPath)}`,
  );
  return true;
}

async function scaffoldFile(
  templatePath: string,
  outputPath: string,
  force: boolean,
  options: { outputDir?: string } = {},
): Promise<boolean> {
  if (fs.existsSync(outputPath) && !force) {
    // Non-interactive (no TTY): never block on a prompt. Skip the existing file
    // so --yes / piped / CI invocations stay deterministic instead of hanging
    // forever waiting on stdin. Use --force to overwrite in these contexts.
    if (!process.stdin.isTTY) {
      return false;
    }

    const response = await prompts({
      type: "confirm",
      name: "overwrite",
      message: `${path.basename(outputPath)} already exists at ${outputPath}. Overwrite?`,
      initial: false,
    });

    if (!response.overwrite) {
      return false;
    }
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  let content = fs.readFileSync(templatePath, "utf-8");
  if (content.includes("__KHOTAN_INGEST_IMPORT__")) {
    const outputDir = options.outputDir ?? "khotan";
    const importBase = outputDir.startsWith("src/")
      ? `@/${outputDir.slice(4)}`
      : `@/${outputDir}`;
    content = content.replace(
      "__KHOTAN_INGEST_IMPORT__",
      `${importBase}/ingests/ingest.example`,
    );
  }
  fs.writeFileSync(outputPath, content, "utf-8");
  return true;
}

async function checkAndInstallDeps(
  cwd: string,
  deps: ComponentDeps,
  autoYes: boolean,
): Promise<void> {
  const allPackages = [
    ...(deps.npmPackages ?? []),
    ...(deps.npmDevPackages ?? []),
  ];
  const missingPkgs =
    allPackages.length > 0 ? checkNpmPackages(cwd, allPackages) : [];
  const missingShadcn = deps.shadcnComponents
    ? checkShadcnComponents(cwd, deps.shadcnComponents)
    : [];

  if (missingPkgs.length === 0 && missingShadcn.length === 0) {
    return;
  }

  if (missingPkgs.length > 0) {
    console.log(`\nMissing npm packages: ${missingPkgs.join(", ")}`);
  }
  if (missingShadcn.length > 0) {
    console.log(`Missing shadcn components: ${missingShadcn.join(", ")}`);
  }

  let shouldInstall = autoYes;
  if (!shouldInstall && process.stdin.isTTY) {
    const response = await prompts({
      type: "confirm",
      name: "install",
      message: "Install missing dependencies?",
      initial: true,
    });
    shouldInstall = response.install === true;
  }

  if (!shouldInstall) {
    console.warn(
      "⚠ Skipping dependency install. The component may not work without them.",
    );
    return;
  }

  if (missingPkgs.length > 0) {
    const regularPkgs = missingPkgs.filter(
      (p) => !(deps.npmDevPackages ?? []).includes(p),
    );
    const devPkgs = missingPkgs.filter((p) =>
      (deps.npmDevPackages ?? []).includes(p),
    );

    if (regularPkgs.length > 0) {
      console.log(`Installing ${regularPkgs.join(", ")}...`);
      const result = installPackages(cwd, regularPkgs);
      if (result.success) {
        console.log(`✓ Installed ${regularPkgs.join(", ")}`);
      } else {
        console.error(
          `✗ Failed to install packages: ${result.error ?? "unknown error"}`,
        );
      }
    }

    if (devPkgs.length > 0) {
      console.log(`Installing ${devPkgs.join(", ")} (dev)...`);
      const result = installPackages(cwd, devPkgs, { devDependency: true });
      if (result.success) {
        console.log(`✓ Installed ${devPkgs.join(", ")} as dev dependencies`);
      } else {
        console.error(
          `✗ Failed to install dev packages: ${result.error ?? "unknown error"}`,
        );
      }
    }
  }

  if (missingShadcn.length > 0) {
    console.log(`Installing shadcn components: ${missingShadcn.join(", ")}...`);
    const result = installShadcnComponents(cwd, missingShadcn);
    if (result.success) {
      console.log(`✓ Installed shadcn components: ${missingShadcn.join(", ")}`);
    } else {
      console.error(
        `✗ Failed to install shadcn components: ${result.error ?? "unknown error"}`,
      );
    }
  }
}

/**
 * Internal function to run `add <name>` for required component dependencies.
 * Uses a direct import rather than spawning a subprocess, which avoids
 * unreliable path resolution under npx/pnpm exec/bunx.
 */
async function addRequiredComponent(
  componentName: string,
  cwd: string,
  opts: { force?: boolean; yes?: boolean; withoutUi?: boolean },
): Promise<void> {
  await addCommand.parseAsync(
    [
      componentName,
      ...(opts.force ? ["--force"] : []),
      ...(opts.yes ? ["--yes"] : []),
      ...(opts.withoutUi ? ["--without-ui"] : []),
    ],
    { from: "user" },
  );
}

export const addCommand = new Command("add")
  .description("Add a component or block to your project")
  .argument(
    "<name>",
    "Component or block to add (e.g., plug, inflow, outflow, relay, schema, cron, hub, config-page-1)",
  )
  .option("-f, --force", "Overwrite existing files without prompting")
  .option("-y, --yes", "Auto-accept all install prompts (non-interactive mode)")
  .option("--without-ui", "Skip UI component scaffolding")
  .action(
    async (
      componentName: string,
      opts: { force?: boolean; yes?: boolean; withoutUi?: boolean },
    ) => {
      let config = loadConfigOutputDir(process.cwd());

      if (!config) {
        console.log("No khotan.config.ts found. Running init...\n");
        const initOk = await runInit(process.cwd());
        if (!initOk) {
          console.error("✗ Init failed. Cannot proceed with add.");
          process.exit(1);
        }
        config = loadConfigOutputDir(process.cwd());
        if (!config) {
          console.error("✗ Could not read config after init.");
          process.exit(1);
        }
        console.log("");
      }

      const cwd = process.cwd();

      // Ensure core files (khotan.ts + route.ts) exist — create if missing, never overwrite
      scaffoldCoreFiles(cwd, config.outputDir);

      if (componentName === "cron") {
        const cronConfig = ensureCronVercelConfig(cwd);
        const relPath = path.relative(cwd, cronConfig.path);
        if (cronConfig.status === "created") {
          console.log(`✓ Created ${relPath} with khotan cron dispatcher`);
        } else if (cronConfig.status === "updated") {
          console.log(`✓ Updated ${relPath} with khotan cron dispatcher`);
        } else if (cronConfig.status === "skipped") {
          console.log(`✓ ${relPath} already has khotan cron dispatcher`);
        } else {
          console.warn(
            `⚠ Could not automatically update ${relPath}. Add {"path": "/api/khotan/cron", "schedule": "* * * * *"} to its crons array.`,
          );
        }
        if (cronConfig.status !== "unsupported") {
          if (cronConfig.schedule !== cronConfig.recommendedSchedule) {
            console.warn(
              `⚠ Existing /api/khotan/cron schedule "${cronConfig.schedule ?? "unknown"}" may delay minute-level flow schedules. Run the dispatcher at least as often as the smallest flow/variant schedule granularity.`,
            );
          } else {
            console.log(
              `  Dispatcher cron uses ${cronConfig.recommendedSchedule} so minute-level flow/variant schedules are checked each minute.`,
            );
          }
        }
        console.log(
          "  Set CRON_SECRET in production so /api/khotan/cron is protected.",
        );
        return;
      }

      const result = getEntry(componentName);

      if (!result) {
        const components = listComponents()
          .map((c) => c.name)
          .join(", ");
        const blocks = listBlocks()
          .map((b) => b.name)
          .join(", ");
        console.error(`✗ Unknown name "${componentName}".`);
        console.error(`  Components: ${components}`);
        console.error(`  Blocks:     ${blocks}`);
        process.exit(1);
      }

      const { entry: component, kind } = result;

      // Check required khotan components and offer to add them first
      if (component.requires && component.requires.length > 0) {
        for (const reqName of component.requires) {
          const reqResult = getEntry(reqName);
          if (!reqResult) continue;
          const req = reqResult.entry;

          if (!isScaffolded(req, cwd, config.outputDir)) {
            let shouldAdd = opts.yes ?? false;
            if (!shouldAdd && process.stdin.isTTY) {
              const response = await prompts({
                type: "confirm",
                name: "add",
                message: `"${componentName}" requires the "${reqName}" component. Add it now?`,
                initial: true,
              });
              shouldAdd = response.add === true;
            } else if (!shouldAdd) {
              shouldAdd = true;
            }

            if (shouldAdd) {
              console.log(`\nAdding required component: ${reqName}...`);
              await addRequiredComponent(reqName, cwd, opts);
              console.log("");
            } else {
              console.warn(
                `⚠ Skipping "${reqName}". The ${kind} may not work without it.`,
              );
            }
          }
        }
      }

      // Check and offer to install dependencies
      if (component.dependencies) {
        const deps = { ...component.dependencies };
        if (opts.withoutUi) {
          delete deps.shadcnComponents;
        }
        await checkAndInstallDeps(cwd, deps, opts.yes ?? false);
      }

      // shadcn detection for components that require it
      if (component.requiresShadcn && !opts.withoutUi) {
        const shadcnConfig = path.join(cwd, "components.json");
        if (!fs.existsSync(shadcnConfig)) {
          console.warn(
            "⚠ shadcn/ui is required for the Hub component but components.json was not found.",
          );
          console.warn(
            "  Run `npx shadcn-ui@latest init` first, then re-run this command.\n",
          );
        }
      }

      if (isMultiFile(component)) {
        const hasAgentSkills = component.files.some(
          (f) => f.outputBase === "agentSkills",
        );

        if (hasAgentSkills) {
          const skills: SkillDefinition[] = component.files
            .filter((f) => f.outputBase === "agentSkills")
            .map((f) => ({ name: f.outputFile, templatePath: f.templatePath }));

          const agentsTemplatePath = path.resolve(
            path.dirname(component.files[0]!.templatePath),
            "agents.md",
          );
          const result = installSkills(cwd, skills, agentsTemplatePath, {
            autoYes: opts.yes ?? false,
          });

          if (result.created.length > 0) {
            console.log(
              `\n✓ Installed to ${result.agents.join(", ")} (${String(result.created.length)} files):`,
            );
            for (const f of result.created) {
              console.log(`  ${f}`);
            }
          }
          if (result.skipped.length > 0 && result.created.length === 0) {
            console.log("\n✓ All skill files already exist, skipping");
          }
          return;
        }

        const createdFiles: string[] = [];
        let filesToScaffold = component.files;

        if (opts.withoutUi) {
          filesToScaffold = filesToScaffold.filter(
            (f) => !f.outputFile.endsWith(".tsx"),
          );
        }

        // Route collision detection for blocks outputting to appRoot
        for (const file of filesToScaffold) {
          if (file.outputBase === "appRoot") {
            const baseDir = resolveOutputBase(file, cwd, config.outputDir);
            const outputPath = path.join(baseDir, file.outputFile);
            const routeDir = path.dirname(outputPath);
            const pageExtensions = [
              "page.tsx",
              "page.ts",
              "page.jsx",
              "page.js",
            ];
            const existing = pageExtensions.find((ext) =>
              fs.existsSync(path.join(routeDir, ext)),
            );
            if (existing && existing !== path.basename(file.outputFile)) {
              const relRoute = path.relative(
                cwd,
                path.join(routeDir, existing),
              );
              console.warn(
                `\n⚠ Route collision: ${relRoute} already exists at this path.`,
              );
              console.warn(
                `  Adding "${component.name}" will create a conflicting route file.\n`,
              );
            }
          }
        }

        for (const file of filesToScaffold) {
          const baseDir = resolveOutputBase(file, cwd, config.outputDir);
          const outputPath = path.join(baseDir, file.outputFile);

          const created = await scaffoldFile(
            file.templatePath,
            outputPath,
            opts.force ?? false,
            { outputDir: config.outputDir },
          );

          if (created) {
            createdFiles.push(path.relative(cwd, outputPath));
          }
        }

        if (createdFiles.length > 0) {
          console.log(`\n✓ Created ${String(createdFiles.length)} files:`);
          for (const f of createdFiles) {
            console.log(`  ${f}`);
          }
        }

        if (componentName === "auth") {
          wireAuthHook(cwd, config.outputDir);
        }

        if (component.requiresWorkflowIntegration) {
          const workflowConfig = ensureWorkflowNextConfig(cwd);
          const relPath = path.relative(cwd, workflowConfig.path);
          if (workflowConfig.status === "created") {
            console.log(`✓ Created ${relPath} with Workflow integration`);
          } else if (workflowConfig.status === "updated") {
            console.log(`✓ Updated ${relPath} with Workflow integration`);
          } else if (workflowConfig.status === "skipped") {
            console.log(`✓ ${relPath} already has Workflow integration`);
          } else {
            console.warn(
              `⚠ Could not automatically update ${relPath} for Workflow integration. Wrap its default export with withWorkflow() from "workflow/next".`,
            );
          }
          warnAboutWorkflowProxy(cwd);
        }

        if (componentName === "hub") {
          console.log("\nNext steps:");
          console.log(
            "  1. Render <KhotanHub /> on a page, or `npx khotan-data add config-page-1` for a ready-made /config route",
          );
        }

        return;
      }

      if (!component.templatePath || !component.outputFile) {
        console.error(
          `✗ ${kind === "block" ? "Block" : "Component"} "${componentName}" has no template.`,
        );
        process.exit(1);
      }

      // Schema-specific: detect Drizzle schema directory
      let outputDir = path.resolve(cwd, config.outputDir);
      let schemaDir: string | null = null;

      if (componentName === "schema") {
        schemaDir = resolveDrizzleSchemaDir(cwd);

        // Conventional fallback when no drizzle.config.ts is detected. Never
        // fall back to the factory `outputDir`, whose `khotan.ts` collides with
        // the factory config file of the same name.
        const fallbackSchemaDir = defaultDrizzleSchemaDir(cwd);

        if (schemaDir) {
          outputDir = path.resolve(cwd, schemaDir);
          console.log(`✓ Detected Drizzle schema directory: ${schemaDir}`);
        } else if (process.stdin.isTTY) {
          const response = await prompts(
            {
              type: "text",
              name: "schemaPath",
              message: "Where should the schema file be placed?",
              initial: fallbackSchemaDir,
            },
            {
              onCancel: () => {
                /* noop */
              },
            },
          );

          const schemaPath = response.schemaPath as string | undefined;
          // Fall back to the default dir when the prompt response is empty or unset.
          const resolvedSchemaPath =
            schemaPath && schemaPath.length > 0
              ? schemaPath
              : fallbackSchemaDir;
          const drizzleConfig = scaffoldDrizzleConfig(cwd, resolvedSchemaPath);
          outputDir = path.resolve(cwd, resolvedSchemaPath);
          if (drizzleConfig.status === "created") {
            console.log(
              `✓ Created drizzle.config.ts with schema "./${resolvedSchemaPath}/*"`,
            );
          }
        } else {
          const drizzleConfig = scaffoldDrizzleConfig(cwd, fallbackSchemaDir);
          outputDir = path.resolve(cwd, fallbackSchemaDir);
          if (drizzleConfig.status === "created") {
            console.log(
              `✓ Created drizzle.config.ts with schema "./${fallbackSchemaDir}/*"`,
            );
          } else {
            console.log(
              `✓ No drizzle.config.ts detected; placing schema in ${fallbackSchemaDir}`,
            );
          }
        }
      }

      const outputPath = path.join(outputDir, component.outputFile);

      // Safety net: the schema template's filename is `khotan.ts`, the same as
      // the factory config. Refuse to ever write the schema over it.
      if (componentName === "schema") {
        const factoryConfigPath = path.resolve(
          cwd,
          config.outputDir,
          "khotan.ts",
        );
        if (path.resolve(outputPath) === factoryConfigPath) {
          console.error(
            `✗ Refusing to write the Drizzle schema over the factory config (${path.relative(cwd, factoryConfigPath)}).`,
          );
          console.error(
            `  Add a drizzle.config.ts with a schema dir (e.g. schema: "./src/db/schema/*") and re-run,`,
          );
          console.error(
            `  or run \`npx khotan-data init --full\` to scaffold Drizzle.`,
          );
          process.exit(1);
        }
      }

      const created = await scaffoldFile(
        component.templatePath,
        outputPath,
        opts.force ?? false,
        { outputDir: config.outputDir },
      );

      if (!created) {
        if (fs.existsSync(outputPath)) {
          console.log(
            `✓ ${path.relative(cwd, outputPath)} already exists, skipping (use --force to overwrite)`,
          );
        } else {
          console.log("Cancelled.");
        }
        return;
      }

      console.log(`✓ Created ${path.relative(cwd, outputPath)}`);

      if (component.requiresWorkflowIntegration) {
        const workflowConfig = ensureWorkflowNextConfig(cwd);
        const relPath = path.relative(cwd, workflowConfig.path);
        if (workflowConfig.status === "created") {
          console.log(`✓ Created ${relPath} with Workflow integration`);
        } else if (workflowConfig.status === "updated") {
          console.log(`✓ Updated ${relPath} with Workflow integration`);
        } else if (workflowConfig.status === "skipped") {
          console.log(`✓ ${relPath} already has Workflow integration`);
        } else {
          console.warn(
            `⚠ Could not automatically update ${relPath} for Workflow integration. Wrap its default export with withWorkflow() from "workflow/next".`,
          );
        }
        warnAboutWorkflowProxy(cwd);
      }

      if (componentName === "schema") {
        const autoYes = opts.yes ?? false;

        const singleFile = detectSingleFileSchema(cwd);
        if (singleFile) {
          const relConfig = path.relative(cwd, singleFile.configPath);
          console.log(
            `\n⚠ ${relConfig} points to a single file ("${singleFile.currentValue}").`,
          );
          console.log(
            `  Drizzle Kit won't pick up khotan.ts unless the schema is a glob.`,
          );

          let shouldUpdate = autoYes;
          if (!shouldUpdate && process.stdin.isTTY) {
            const response = await prompts({
              type: "confirm",
              name: "update",
              message: `Update schema to "${singleFile.globValue}" so Drizzle Kit picks up all files?`,
              initial: true,
            });
            shouldUpdate = response.update === true;
          }

          if (shouldUpdate) {
            const updated = updateDrizzleConfigSchema(
              singleFile.configPath,
              singleFile.currentValue,
              singleFile.globValue,
            );
            if (updated) {
              console.log(
                `✓ Updated ${relConfig}: schema → "${singleFile.globValue}"`,
              );
            } else {
              console.warn(
                `⚠ Could not update ${relConfig} automatically. Set schema to "${singleFile.globValue}" manually.`,
              );
            }
          } else {
            console.log(
              `  Skipped. Update the schema value manually or Drizzle Kit won't see the khotan tables.`,
            );
          }
        }

        const barrelPath = path.join(outputDir, "index.ts");

        if (fs.existsSync(barrelPath)) {
          const barrelContent = fs.readFileSync(barrelPath, "utf-8");
          const relBarrel = path.relative(cwd, barrelPath);

          if (barrelContent.includes("./khotan")) {
            console.log(`✓ ${relBarrel} already re-exports khotan`);
          } else {
            let shouldUpdate = autoYes;
            if (!shouldUpdate && process.stdin.isTTY) {
              const response = await prompts({
                type: "confirm",
                name: "update",
                message: `Add \`export * from "./khotan"\` to ${relBarrel}?`,
                initial: true,
              });
              shouldUpdate = response.update === true;
            }

            if (shouldUpdate) {
              const separator = barrelContent.endsWith("\n") ? "" : "\n";
              fs.appendFileSync(
                barrelPath,
                `${separator}export * from "./khotan";\n`,
              );
              console.log(`✓ Updated ${relBarrel} with khotan re-export`);
            } else {
              console.log(`  Skipped. Add this to ${relBarrel} manually:\n`);
              console.log(`    export * from "./khotan";`);
            }
          }
        } else {
          const relDir = path.relative(cwd, outputDir);
          const importBase = relDir.replace(/^src\//, "@/");
          console.log(
            `\nAdd this re-export to your Drizzle schema barrel file:\n`,
          );
          console.log(`  export * from "${importBase}/khotan";`);
        }
      } else {
        const importBase = config.outputDir.replace(/^src\//, "@/");
        if (componentName === "wire") {
          console.log(`\nUsage:\n`);
          console.log(
            `  import { wire } from "${importBase}/wires/${component.name}";`,
          );
          console.log(`  import { myPlug } from "${importBase}/plugs/plug";`);
          console.log(`  import { db } from "@/db";\n`);
          console.log(`  const myWire = wire({`);
          console.log(`    plug: myPlug,`);
          console.log(`    db,`);
          console.log(`    subscribe: {`);
          console.log(`      path: "/webhooks",`);
          console.log(
            `      buildBody: (callbackUrl) => ({ url: callbackUrl, events: ["*"] }),`,
          );
          console.log(`      parseId: (res) => (res as { id: string }).id,`);
          console.log(`    },`);
          console.log(`    unsubscribe: {`);
          console.log(`      path: (remoteId) => \`/webhooks/\${remoteId}\`,`);
          console.log(`    },`);
          console.log(`  });`);
        } else {
          console.log(`\nUsage:\n`);
          console.log(
            `  import { plug, bearer } from "${importBase}/plugs/${component.name}";`,
          );
          console.log(`\n  const api = plug({`);
          console.log(`    baseUrl: "https://api.example.com",`);
          console.log(`    auth: bearer(process.env.API_TOKEN!),`);
          console.log(`  });`);
        }
      }
    },
  );
