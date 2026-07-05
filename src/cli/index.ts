import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initCommand } from "./commands/init.js";
import { addCommand } from "./commands/add.js";
import { generateCommand } from "./commands/generate.js";
import { migrateCommand } from "./commands/migrate.js";
import { doctorCommand } from "./commands/doctor.js";
import { plugCommand } from "./commands/probe.js";
import { wireCommand } from "./commands/wire.js";
import { flowsCommand } from "./commands/flows.js";
import { mappingsCommand } from "./commands/mappings.js";
import { whoamiCommand } from "./commands/whoami.js";
import { databasesCommand } from "./commands/databases.js";
import { appsCommand } from "./commands/apps.js";
import { bootstrapCommand } from "./commands/bootstrap.js";
import { upgradeCommand } from "./commands/upgrade.js";
import { loadEnvFileIntoProcess } from "./cli-api.js";

const __cliDirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  fs.readFileSync(path.resolve(__cliDirname, "..", "package.json"), "utf-8"),
) as { version: string };

const program = new Command();

program
  .name("khotan-data")
  .description("Scaffold data components into your project")
  .version(pkg.version)
  .option("--env-file <path>", "Load a dotenv file for this CLI invocation")
  .option("--org-id <id>", "Set KHOTAN_ORG_ID for this CLI invocation")
  .hook("preAction", (thisCommand, actionCommand) => {
    const opts = actionCommand.optsWithGlobals<{
      envFile?: string;
      orgId?: string;
    }>();
    if (opts.envFile) {
      loadEnvFileIntoProcess(opts.envFile);
    }
    if (opts.orgId) {
      process.env["KHOTAN_ORG_ID"] = opts.orgId;
    }
  });

program.addCommand(initCommand);
program.addCommand(addCommand);
program.addCommand(generateCommand);
program.addCommand(migrateCommand);
program.addCommand(doctorCommand);
program.addCommand(plugCommand);
program.addCommand(wireCommand);
program.addCommand(flowsCommand);
program.addCommand(mappingsCommand);
program.addCommand(whoamiCommand);
program.addCommand(databasesCommand);
program.addCommand(appsCommand);
program.addCommand(bootstrapCommand);
program.addCommand(upgradeCommand);

program.parse();
