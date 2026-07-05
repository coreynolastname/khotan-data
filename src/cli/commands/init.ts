import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import prompts from "prompts";
import { configTemplate } from "../config-template.js";
import {
  detectPackageManager,
  checkNpmPackages,
  checkShadcnComponents,
  installPackages,
  installShadcnComponents,
} from "../deps.js";
import { getComponent, isMultiFile } from "../registry.js";
import { installSkills, type SkillDefinition } from "../agent-detect.js";
import { resolveOutputDir } from "../cli-api.js";
import {
  defaultDrizzleSchemaDir,
  scaffoldDrizzleConfig,
} from "../drizzle-detect.js";
import {
  renderCoreRouteContent,
  readStampedTemplateContent,
  stampGeneratedContent,
} from "../scaffold.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function hasSrcLayout(cwd: string): boolean {
  return fs.existsSync(path.join(cwd, "src", "app"));
}

interface StepResult {
  name: string;
  status: "success" | "skipped" | "failed";
  error?: string | undefined;
}

const DRIZZLE_PACKAGES = ["drizzle-orm", "postgres"];
const DRIZZLE_DEV_PACKAGES = ["drizzle-kit"];
const SHADCN_COMPONENTS = ["card", "badge", "table", "switch"];

const ENV_TEMPLATE_ENTRIES = [
  {
    key: "DATABASE_URL",
    value: "postgres://user:password@localhost:5432/app",
    comment: "Postgres connection string used by Drizzle and khotan.",
  },
  {
    key: "KHOTAN_SECRET",
    value: "",
    comment:
      "AES-256-GCM key for encrypted plug vars. Generate with: openssl rand -hex 32",
  },
  {
    key: "KHOTAN_DEBUG",
    value: "1",
    comment:
      "Enables khotan debug routes and CLI plug debugging in development only.",
  },
  {
    key: "KHOTAN_WEBHOOK_URL",
    value: "https://example.ngrok.app",
    comment: "Public base URL for webhook callbacks during local development.",
  },
  {
    key: "CRON_SECRET",
    value: "",
    comment:
      "Bearer token for /api/khotan/cron in production. Generate with: openssl rand -hex 32",
  },
];

export interface EnvTemplateResult {
  status: "created" | "updated" | "skipped";
  path: string;
  keys: string[];
}

function hasEnvKey(content: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*(?:export\\s+)?${escaped}\\s*=`, "m").test(content);
}

function renderEnvEntry(entry: (typeof ENV_TEMPLATE_ENTRIES)[number]): string {
  return `# ${entry.comment}\n${entry.key}=${entry.value}\n`;
}

export function ensureEnvTemplate(cwd: string): EnvTemplateResult {
  const envPath = path.join(cwd, ".env.template");

  if (!fs.existsSync(envPath)) {
    const content =
      `# Khotan environment template\n` +
      `# Copy values into .env.local or your deployment environment.\n\n` +
      ENV_TEMPLATE_ENTRIES.map(renderEnvEntry).join("\n");
    fs.writeFileSync(
      envPath,
      content.endsWith("\n") ? content : `${content}\n`,
    );
    return {
      status: "created",
      path: envPath,
      keys: ENV_TEMPLATE_ENTRIES.map((entry) => entry.key),
    };
  }

  const content = fs.readFileSync(envPath, "utf-8");
  const missing = ENV_TEMPLATE_ENTRIES.filter(
    (entry) => !hasEnvKey(content, entry.key),
  );

  if (missing.length === 0) {
    return { status: "skipped", path: envPath, keys: [] };
  }

  const separator = content.endsWith("\n") ? "\n" : "\n\n";
  fs.appendFileSync(
    envPath,
    `${separator}# Added by khotan init\n${missing.map(renderEnvEntry).join("\n")}`,
    "utf-8",
  );

  return {
    status: "updated",
    path: envPath,
    keys: missing.map((entry) => entry.key),
  };
}

/**
 * Scaffold the core khotan files (khotan.ts instance + route.ts).
 * Never overwrites existing files. Returns list of created file paths.
 */
export function scaffoldCoreFiles(cwd: string, outputDir: string): string[] {
  const created: string[] = [];

  const khotanConfigTemplatePath = path.resolve(
    __dirname,
    "templates",
    "khotan-config.ts",
  );

  // Scaffold khotan.ts (instance config) — never overwrite
  const khotanTsPath = path.join(path.resolve(cwd, outputDir), "khotan.ts");
  if (!fs.existsSync(khotanTsPath)) {
    fs.mkdirSync(path.dirname(khotanTsPath), { recursive: true });
    fs.writeFileSync(
      khotanTsPath,
      readStampedTemplateContent(khotanConfigTemplatePath),
      "utf-8",
    );
    created.push(path.relative(cwd, khotanTsPath));
  } else {
    console.log(
      `✓ ${path.relative(cwd, khotanTsPath)} already exists, skipping`,
    );
  }

  // Scaffold route.ts (API catch-all) — never overwrite.
  const routeDir = path.resolve(
    cwd,
    hasSrcLayout(cwd)
      ? "src/app/api/khotan/[...all]"
      : "app/api/khotan/[...all]",
  );
  const routePath = path.join(routeDir, "route.ts");
  if (!fs.existsSync(routePath)) {
    fs.mkdirSync(routeDir, { recursive: true });
    const routeContent = stampGeneratedContent(
      renderCoreRouteContent(cwd, outputDir),
      "khotan-route.ts",
    );
    fs.writeFileSync(routePath, routeContent, "utf-8");
    created.push(path.relative(cwd, routePath));
  } else {
    console.log(`✓ ${path.relative(cwd, routePath)} already exists, skipping`);
  }

  return created;
}

/**
 * Scaffold a Drizzle config + db instance so the factory's `@/db` import
 * resolves and `migrate` works out of the box. Never overwrites existing files.
 * Used by `init --full` (greenfield setup).
 */
export function scaffoldDrizzleSetup(cwd: string): StepResult {
  const srcLayout = hasSrcLayout(cwd);
  const schemaDirRel = defaultDrizzleSchemaDir(cwd);
  const dbDirRel = srcLayout ? "src/db" : "db";
  const created: string[] = [];

  const drizzleConfig = scaffoldDrizzleConfig(cwd, schemaDirRel);
  if (drizzleConfig.status === "created") {
    created.push("drizzle.config.ts");
  }

  const dbIndexPath = path.join(cwd, dbDirRel, "index.ts");
  if (!fs.existsSync(dbIndexPath)) {
    fs.mkdirSync(path.dirname(dbIndexPath), { recursive: true });
    const content =
      `import { drizzle } from "drizzle-orm/postgres-js";\n` +
      `import postgres from "postgres";\n` +
      `\n` +
      `const connectionString = process.env.DATABASE_URL;\n` +
      `if (!connectionString) {\n` +
      `  throw new Error("DATABASE_URL is not set");\n` +
      `}\n` +
      `\n` +
      `const client = postgres(connectionString, { prepare: false });\n` +
      `\n` +
      `export const db = drizzle(client);\n`;
    fs.writeFileSync(dbIndexPath, content, "utf-8");
    created.push(`${dbDirRel}/index.ts`);
  }

  if (created.length > 0) {
    console.log(`✓ Scaffolded Drizzle: ${created.join(", ")}`);
    return { name: "Scaffold Drizzle config + db instance", status: "success" };
  }

  console.log("✓ Drizzle config + db instance already present, skipping");
  return { name: "Scaffold Drizzle config + db instance", status: "skipped" };
}

// Proxy/middleware files that can intercept requests before they reach a route.
const MIDDLEWARE_CANDIDATES = [
  "middleware.ts",
  "middleware.js",
  "src/middleware.ts",
  "src/middleware.js",
  "proxy.ts",
  "proxy.js",
  "src/proxy.ts",
  "src/proxy.js",
];

/**
 * Detect a Next.js middleware/proxy file and warn when it may intercept the
 * Vercel Workflow runtime paths (`/.well-known/workflow/*`). Returns true if a
 * warning was emitted.
 */
export function warnAboutWorkflowProxy(cwd: string): boolean {
  const found = MIDDLEWARE_CANDIDATES.map((rel) => ({
    rel,
    abs: path.join(cwd, rel),
  })).find((c) => fs.existsSync(c.abs));

  if (!found) return false;

  let contents = "";
  try {
    contents = fs.readFileSync(found.abs, "utf-8");
  } catch {
    return false;
  }

  if (/\.well-known|workflow/i.test(contents)) {
    return false;
  }

  console.log(
    `\n⚠ Detected ${found.rel}. Vercel Workflow (used by inflows, outflows,\n` +
      `  relays, catch, and pass) communicates over /.well-known/workflow/*.\n` +
      `  If your middleware/proxy matcher captures these paths, durable runs\n` +
      `  will silently fail. Exclude them from your matcher, e.g.:\n\n` +
      `    export const config = {\n` +
      `      matcher: ["/((?!_next|.well-known/workflow).*)"],\n` +
      `    };\n`,
  );
  return true;
}

async function runFullSetup(
  cwd: string,
  opts: { yes?: boolean },
): Promise<StepResult[]> {
  const results: StepResult[] = [];
  const pm = detectPackageManager(cwd);
  console.log(`Detected package manager: ${pm.name}\n`);

  // Step 1: Install drizzle packages
  const missingDrizzle = checkNpmPackages(cwd, DRIZZLE_PACKAGES);
  const missingDrizzleDev = checkNpmPackages(cwd, DRIZZLE_DEV_PACKAGES);

  if (missingDrizzle.length > 0) {
    console.log(`Installing ${missingDrizzle.join(", ")}...`);
    const result = installPackages(cwd, missingDrizzle);
    if (result.success) {
      console.log(`✓ Installed ${missingDrizzle.join(", ")}`);
      results.push({ name: "Install drizzle packages", status: "success" });
    } else {
      console.error(`✗ Failed: ${result.error ?? "unknown error"}`);
      results.push({
        name: "Install drizzle packages",
        status: "failed",
        error: result.error,
      });
    }
  } else {
    console.log("✓ Drizzle packages already installed, skipping");
    results.push({ name: "Install drizzle packages", status: "skipped" });
  }

  if (missingDrizzleDev.length > 0) {
    console.log(`Installing ${missingDrizzleDev.join(", ")} (dev)...`);
    const result = installPackages(cwd, missingDrizzleDev, {
      devDependency: true,
    });
    if (result.success) {
      console.log(
        `✓ Installed ${missingDrizzleDev.join(", ")} as dev dependencies`,
      );
      results.push({ name: "Install drizzle-kit", status: "success" });
    } else {
      console.error(`✗ Failed: ${result.error ?? "unknown error"}`);
      results.push({
        name: "Install drizzle-kit",
        status: "failed",
        error: result.error,
      });
    }
  } else {
    console.log("✓ drizzle-kit already installed, skipping");
    results.push({ name: "Install drizzle-kit", status: "skipped" });
  }

  // Step 2: Initialize shadcn if needed
  const componentsJsonPath = path.join(cwd, "components.json");
  if (!fs.existsSync(componentsJsonPath)) {
    console.log("\nInitializing shadcn/ui...");
    try {
      execSync("npx shadcn@latest init --defaults --yes", {
        cwd,
        stdio: "pipe",
        encoding: "utf-8",
      });
      console.log("✓ Initialized shadcn/ui");
      results.push({ name: "Initialize shadcn", status: "success" });
    } catch (err: unknown) {
      const e = err as { stderr?: string; stdout?: string };
      const error = e.stderr ?? e.stdout ?? "shadcn init failed";
      console.error(`✗ Failed to initialize shadcn: ${error}`);
      results.push({ name: "Initialize shadcn", status: "failed", error });
    }
  } else {
    console.log("\n✓ shadcn/ui already configured, skipping init");
    results.push({ name: "Initialize shadcn", status: "skipped" });
  }

  // Step 3: Install shadcn components
  const missingShadcn = checkShadcnComponents(cwd, SHADCN_COMPONENTS);
  if (missingShadcn.length > 0) {
    console.log(
      `\nInstalling shadcn components: ${missingShadcn.join(", ")}...`,
    );
    const result = installShadcnComponents(cwd, missingShadcn);
    if (result.success) {
      console.log(`✓ Installed shadcn components: ${missingShadcn.join(", ")}`);
      results.push({ name: "Install shadcn components", status: "success" });
    } else {
      console.error(`✗ Failed: ${result.error ?? "unknown error"}`);
      results.push({
        name: "Install shadcn components",
        status: "failed",
        error: result.error,
      });
    }
  } else {
    console.log("\n✓ All required shadcn components already present, skipping");
    results.push({ name: "Install shadcn components", status: "skipped" });
  }

  // Step 4: Create khotan config + core files
  const configPath = path.resolve(cwd, "khotan.config.ts");
  const outputDir = resolveOutputDir(cwd);
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, configTemplate(outputDir), "utf-8");
    console.log(`\n✓ Created khotan.config.ts (outputDir: ${outputDir})`);
    results.push({ name: "Create khotan.config.ts", status: "success" });
  } else {
    console.log("\n✓ khotan.config.ts already exists, skipping");
    results.push({ name: "Create khotan.config.ts", status: "skipped" });
  }

  const coreFiles = scaffoldCoreFiles(cwd, outputDir);
  if (coreFiles.length > 0) {
    results.push({
      name: `Scaffold ${coreFiles.join(", ")}`,
      status: "success",
    });
  } else {
    results.push({ name: "Scaffold core files", status: "skipped" });
  }

  // Step 4b: Scaffold Drizzle config + db instance so `@/db` resolves
  results.push(scaffoldDrizzleSetup(cwd));

  const envTemplate = ensureEnvTemplate(cwd);
  const envRelPath = path.relative(cwd, envTemplate.path);
  if (envTemplate.status === "created") {
    console.log(`✓ Created ${envRelPath}`);
    results.push({ name: `Create ${envRelPath}`, status: "success" });
  } else if (envTemplate.status === "updated") {
    console.log(`✓ Updated ${envRelPath}: ${envTemplate.keys.join(", ")}`);
    results.push({ name: `Update ${envRelPath}`, status: "success" });
  } else {
    console.log(`✓ ${envRelPath} already has khotan variables, skipping`);
    results.push({ name: `Update ${envRelPath}`, status: "skipped" });
  }

  // Step 5: Install khotan-data package
  results.push(ensureKhotanDataInstalled(cwd));

  warnAboutWorkflowProxy(cwd);

  // Step 6: Install agent skills (--yes makes this non-interactive)
  const skillCount = scaffoldAgentSkills(cwd, opts.yes ?? false);
  if (skillCount > 0) {
    console.log(`✓ Installed ${String(skillCount)} agent skills`);
    results.push({ name: "Install agent skills", status: "success" });
  } else {
    results.push({ name: "Install agent skills", status: "skipped" });
  }

  return results;
}

function ensureKhotanDataInstalled(cwd: string): StepResult {
  const missing = checkNpmPackages(cwd, ["khotan-data"]);
  if (missing.length === 0) {
    console.log("✓ khotan-data already installed, skipping");
    return { name: "Install khotan-data", status: "skipped" };
  }

  console.log("Installing khotan-data...");
  const result = installPackages(cwd, ["khotan-data"]);
  if (result.success) {
    console.log("✓ Installed khotan-data");
    return { name: "Install khotan-data", status: "success" };
  }

  console.error(
    `✗ Failed to install khotan-data: ${result.error ?? "unknown error"}`,
  );
  return { name: "Install khotan-data", status: "failed", error: result.error };
}

/**
 * Core init logic reusable from the add command.
 * Creates khotan.config.ts, khotan.ts, route.ts, and installs khotan-data.
 * Never overwrites existing files.
 * Returns true if the config file exists after running.
 */
export async function runInit(cwd: string): Promise<boolean> {
  const configPath = path.resolve(cwd, "khotan.config.ts");
  const outputDir = resolveOutputDir(cwd);

  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, configTemplate(outputDir), "utf-8");
    console.log(`✓ Created khotan.config.ts (outputDir: ${outputDir})`);
  }

  scaffoldCoreFiles(cwd, outputDir);
  const envTemplate = ensureEnvTemplate(cwd);
  const envRelPath = path.relative(cwd, envTemplate.path);
  if (envTemplate.status === "created") {
    console.log(`✓ Created ${envRelPath}`);
  } else if (envTemplate.status === "updated") {
    console.log(`✓ Updated ${envRelPath}: ${envTemplate.keys.join(", ")}`);
  }
  ensureKhotanDataInstalled(cwd);
  warnAboutWorkflowProxy(cwd);

  return fs.existsSync(configPath);
}

export const SKILL_COMPONENTS = [
  "skill-build",
  "skill-setup",
  "skill-plug",
  "agent-skill",
  "skill-flow",
  "skill-webhook",
  "skill-cache",
  "skill-mappings",
  "skill-frontend",
];

function scaffoldAgentSkills(cwd: string, autoYes = false): number {
  const skills: SkillDefinition[] = [];

  for (const name of SKILL_COMPONENTS) {
    const entry = getComponent(name);
    if (!entry || !isMultiFile(entry)) continue;

    for (const file of entry.files) {
      if (file.outputBase === "agentSkills") {
        skills.push({ name: file.outputFile, templatePath: file.templatePath });
      }
    }
  }

  if (skills.length === 0) return 0;

  const agentsTemplatePath = path.resolve(__dirname, "templates", "agents.md");
  const result = installSkills(cwd, skills, agentsTemplatePath, { autoYes });

  if (result.created.length > 0) {
    console.log(`  Agents detected: ${result.agents.join(", ")}`);
    for (const f of result.created) {
      console.log(`  ✓ Created ${f}`);
    }
  }

  return result.created.length;
}

export const initCommand = new Command("init")
  .description("Initialize khotan in your project")
  .option(
    "--full",
    "Full project setup: install drizzle, shadcn, and configure everything",
  )
  .option(
    "--skills-only",
    "Only install agent skills; skip config, core files, and package install",
  )
  .option("--schema", "Also scaffold the Drizzle khotan schema")
  .option("-y, --yes", "Auto-accept all prompts (non-interactive mode)")
  .action(
    async (opts: {
      full?: boolean;
      skillsOnly?: boolean;
      schema?: boolean;
      yes?: boolean;
    }) => {
      const cwd = process.cwd();

      if (opts.skillsOnly && opts.full) {
        console.error("✗ --skills-only cannot be combined with --full");
        process.exit(1);
      }
      if (opts.skillsOnly && opts.schema) {
        console.error("✗ --skills-only cannot be combined with --schema");
        process.exit(1);
      }

      // Skills-only: install the agent skill set and nothing else. Useful in
      // polyrepo setups where the khotan-data runtime lives elsewhere and this
      // location only hosts the skills the agent operates from.
      if (opts.skillsOnly) {
        const count = scaffoldAgentSkills(cwd, opts.yes ?? false);
        console.log(
          count > 0
            ? `✓ Installed ${String(count)} agent skills`
            : "✓ Agent skills already up to date",
        );
        return;
      }

      if (opts.full) {
        console.log("Running full khotan setup...\n");
        const results = await runFullSetup(cwd, opts);

        const succeeded = results.filter((r) => r.status === "success");
        const skipped = results.filter((r) => r.status === "skipped");
        const failed = results.filter((r) => r.status === "failed");

        console.log("\n── Setup Summary ──");
        for (const r of succeeded) {
          console.log(`  ✓ ${r.name}`);
        }
        for (const r of skipped) {
          console.log(`  ⊘ ${r.name} (already done)`);
        }
        for (const r of failed) {
          console.log(`  ✗ ${r.name}: ${r.error ?? "unknown error"}`);
        }

        if (failed.length > 0) {
          console.log(
            `\n${String(failed.length)} step(s) failed. You may need to run them manually.`,
          );
          process.exit(1);
        } else {
          console.log("\nAll done! Your project is ready for khotan.");
        }

        if (opts.schema) {
          console.log("\nAdding khotan Drizzle schema...\n");
          const { addCommand } = await import("./add.js");
          await addCommand.parseAsync(
            ["schema", ...(opts.yes ? ["--yes"] : [])],
            { from: "user" },
          );
        }

        return;
      }

      const configPath = path.resolve(cwd, "khotan.config.ts");
      const outputDir = resolveOutputDir(cwd);

      if (fs.existsSync(configPath)) {
        console.log(`✓ khotan.config.ts already exists, skipping`);
      } else {
        fs.writeFileSync(configPath, configTemplate(outputDir), "utf-8");
        console.log(`✓ Created khotan.config.ts (outputDir: ${outputDir})`);
      }

      const coreFiles = scaffoldCoreFiles(cwd, outputDir);

      const envTemplate = ensureEnvTemplate(cwd);
      const envRelPath = path.relative(cwd, envTemplate.path);
      if (envTemplate.status === "created") {
        console.log(`✓ Created ${envRelPath}`);
      } else if (envTemplate.status === "updated") {
        console.log(`✓ Updated ${envRelPath}: ${envTemplate.keys.join(", ")}`);
      } else {
        console.log(`✓ ${envRelPath} already has khotan variables, skipping`);
      }

      ensureKhotanDataInstalled(cwd);

      warnAboutWorkflowProxy(cwd);

      // Offer to install agent skills — --yes makes this non-interactive
      let shouldInstallSkills = opts.yes ?? false;
      if (!shouldInstallSkills && process.stdin.isTTY) {
        const response = await prompts({
          type: "confirm",
          name: "install",
          message: "Install agent skills for AI-assisted development? (Y/n)",
          initial: true,
        });
        shouldInstallSkills = response.install === true;
      }
      if (shouldInstallSkills) {
        const count = scaffoldAgentSkills(cwd, opts.yes ?? false);
        if (count > 0) {
          console.log(`✓ Installed ${String(count)} agent skills`);
        }
      }

      const allFiles = [
        ...(fs.existsSync(configPath) && coreFiles.length === 0
          ? []
          : ["khotan.config.ts"]),
        ...coreFiles,
      ];

      if (allFiles.length > 0 || coreFiles.length > 0) {
        console.log("\nNext steps:");
        console.log("  1. Fill in .env.template values in .env.local");
        console.log("  2. Update the db import in your khotan config file");
        console.log(
          "  3. Run `npx khotan-data add plug` to add the HTTP client",
        );
        console.log(
          "  4. Run `npx khotan-data migrate` to create database tables",
        );
      }

      if (opts.schema) {
        console.log("\nAdding khotan Drizzle schema...\n");
        const { addCommand } = await import("./add.js");
        await addCommand.parseAsync(
          ["schema", ...(opts.yes ? ["--yes"] : [])],
          { from: "user" },
        );
      }
    },
  );
