import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ComponentFile {
  templatePath: string;
  /** Output path relative to a base directory determined at scaffold time */
  outputFile: string;
  /**
   * Where to resolve the output path from:
   * - "outputDir" — the khotan outputDir (default)
   * - "components" — components/khotan/ relative to project root
   * - "app" — app/api/khotan/[...all]/ relative to project root (or src/app if src layout)
   * - "appRoot" — app directory root (`src/app` or `app`)
   * - "lib" — lib directory (`src/lib` or `lib`)
   * - "projectRoot" — the project root (cwd)
   * - "agentSkills" — installed to all detected agent directories (Cursor, Claude, Codex, etc.)
   */
  outputBase:
    | "outputDir"
    | "components"
    | "app"
    | "appRoot"
    | "lib"
    | "projectRoot"
    | "agentSkills";
}

/** Skill name extracted from an agentSkills entry (the directory name) */
export function getSkillName(entry: ComponentEntry): string | undefined {
  if (!entry.files) return undefined;
  const skillFile = entry.files.find((f) => f.outputBase === "agentSkills");
  if (!skillFile) return undefined;
  return skillFile.outputFile;
}

export interface ComponentDeps {
  npmPackages?: string[];
  npmDevPackages?: string[];
  shadcnComponents?: string[];
}

export interface ComponentEntry {
  name: string;
  description: string;
  /** Single-file component */
  templatePath?: string;
  outputFile?: string;
  /** Multi-file component */
  files?: ComponentFile[];
  /** Requires shadcn to be installed */
  requiresShadcn?: boolean;
  /** Dependencies this component requires in the user's project */
  dependencies?: ComponentDeps;
  /** Other khotan components/blocks that must be scaffolded first */
  requires?: string[];
  /** Whether this component requires Workflow DevKit integration in Next.js */
  requiresWorkflowIntegration?: boolean;
}

// ---------------------------------------------------------------------------
// Components vs Blocks
// ---------------------------------------------------------------------------
// Components are reusable building blocks: library code, UI primitives, schema
// definitions. They never create routes or pages on their own.
//
// Blocks are sample routes/pages composed from components. They wire components
// into the app router so you can see them running immediately.
//
// Both use the same ComponentEntry shape and are addable via `khotan add`.
// ---------------------------------------------------------------------------

const COMPONENTS: Record<string, ComponentEntry> = {
  auth: {
    name: "auth",
    description:
      "Better Auth setup and authorize hook for the khotan management API",
    dependencies: {
      npmPackages: ["better-auth"],
    },
    files: [
      {
        templatePath: path.resolve(__dirname, "templates", "auth.ts"),
        outputFile: "auth.ts",
        outputBase: "lib",
      },
      {
        templatePath: path.resolve(__dirname, "templates", "auth-route.ts"),
        outputFile: "api/auth/[...all]/route.ts",
        outputBase: "appRoot",
      },
    ],
  },
  plug: {
    name: "plug",
    description:
      "Self-contained fetch wrapper with auth, retry, and pagination",
    files: [
      {
        templatePath: path.resolve(__dirname, "templates", "plug.ts"),
        outputFile: "plugs/plug.ts",
        outputBase: "outputDir",
      },
      {
        templatePath: path.resolve(__dirname, "templates", "plug.example.ts"),
        outputFile: "plugs/plug.example.ts",
        outputBase: "outputDir",
      },
    ],
    dependencies: {
      npmPackages: ["zod"],
    },
  },
  wire: {
    name: "wire",
    description:
      "Webhook subscription lifecycle management using Plug for HTTP",
    requires: ["plug", "schema"],
    requiresShadcn: true,
    dependencies: {
      npmPackages: ["drizzle-orm"],
      shadcnComponents: ["card", "badge", "button"],
    },
    files: [
      {
        templatePath: path.resolve(__dirname, "templates", "wire.ts"),
        outputFile: "wires/wire.ts",
        outputBase: "outputDir",
      },
      {
        templatePath: path.resolve(__dirname, "templates", "api-state.tsx"),
        outputFile: "api-state.tsx",
        outputBase: "components",
      },
      {
        templatePath: path.resolve(__dirname, "templates", "date-time.tsx"),
        outputFile: "date-time.tsx",
        outputBase: "components",
      },
      {
        templatePath: path.resolve(__dirname, "templates", "wire-panel.tsx"),
        outputFile: "wire.tsx",
        outputBase: "components",
      },
    ],
  },
  schema: {
    name: "schema",
    description: "Drizzle table definitions for khotan plugs, flows, and runs",
    templatePath: path.resolve(__dirname, "templates", "schema.ts"),
    outputFile: "khotan.ts",
    dependencies: {
      npmPackages: ["drizzle-orm"],
      npmDevPackages: ["drizzle-kit"],
    },
  },
  cache: {
    name: "cache",
    description:
      "First-class durable cache definitions for khotan sync workloads",
    requires: ["schema"],
    files: [
      {
        templatePath: path.resolve(__dirname, "templates", "cache.ts"),
        outputFile: "caches/cache.ts",
        outputBase: "outputDir",
      },
      {
        templatePath: path.resolve(__dirname, "templates", "cache.example.ts"),
        outputFile: "caches/cache.example.ts",
        outputBase: "outputDir",
      },
    ],
  },
  ingest: {
    name: "ingest",
    description: "Typed inbound destination endpoint with org resolution",
    requires: ["schema"],
    dependencies: {
      npmPackages: ["drizzle-orm", "zod"],
    },
    files: [
      {
        templatePath: path.resolve(__dirname, "templates", "ingest.ts"),
        outputFile: "ingests/ingest.ts",
        outputBase: "outputDir",
      },
      {
        templatePath: path.resolve(__dirname, "templates", "ingest.example.ts"),
        outputFile: "ingests/ingest.example.ts",
        outputBase: "outputDir",
      },
      {
        templatePath: path.resolve(__dirname, "templates", "ingest-route.ts"),
        outputFile: "api/internal/khotan/ingest/example/route.ts",
        outputBase: "appRoot",
      },
    ],
  },
  hub: {
    name: "hub",
    description: "Dashboard UI for managing plugs and flows",
    requiresShadcn: true,
    dependencies: {
      npmPackages: ["drizzle-orm"],
      shadcnComponents: [
        "card",
        "badge",
        "table",
        "switch",
        "button",
        "input",
        "label",
      ],
    },
    files: [
      {
        templatePath: path.resolve(__dirname, "templates", "api-state.tsx"),
        outputFile: "api-state.tsx",
        outputBase: "components",
      },
      {
        templatePath: path.resolve(__dirname, "templates", "date-time.tsx"),
        outputFile: "date-time.tsx",
        outputBase: "components",
      },
      {
        templatePath: path.resolve(__dirname, "templates", "hub.tsx"),
        outputFile: "hub.tsx",
        outputBase: "components",
      },
      {
        templatePath: path.resolve(__dirname, "templates", "wire-panel.tsx"),
        outputFile: "wire.tsx",
        outputBase: "components",
      },
      {
        templatePath: path.resolve(__dirname, "templates", "var-panel.tsx"),
        outputFile: "var-panel.tsx",
        outputBase: "components",
      },
    ],
  },
  logs: {
    name: "logs",
    description: "Paginated UI tables for runs and webhook events",
    requiresShadcn: true,
    dependencies: {
      npmPackages: ["lucide-react"],
      shadcnComponents: ["card", "table", "badge", "button", "switch"],
    },
    files: [
      {
        templatePath: path.resolve(__dirname, "templates", "api-state.tsx"),
        outputFile: "api-state.tsx",
        outputBase: "components",
      },
      {
        templatePath: path.resolve(__dirname, "templates", "date-time.tsx"),
        outputFile: "date-time.tsx",
        outputBase: "components",
      },
      {
        templatePath: path.resolve(__dirname, "templates", "logs.tsx"),
        outputFile: "logs.tsx",
        outputBase: "components",
      },
      {
        templatePath: path.resolve(__dirname, "templates", "runs-table.tsx"),
        outputFile: "runs-table.tsx",
        outputBase: "components",
      },
      {
        templatePath: path.resolve(
          __dirname,
          "templates",
          "webhook-events-table.tsx",
        ),
        outputFile: "webhook-events-table.tsx",
        outputBase: "components",
      },
    ],
  },
  "mapping-browser": {
    name: "mapping-browser",
    description:
      "Searchable mappings browser for listing, creating, editing, and deleting resource mappings",
    requiresShadcn: true,
    dependencies: {
      shadcnComponents: ["card", "table", "button", "input", "label"],
    },
    files: [
      {
        templatePath: path.resolve(__dirname, "templates", "api-state.tsx"),
        outputFile: "api-state.tsx",
        outputBase: "components",
      },
      {
        templatePath: path.resolve(
          __dirname,
          "templates",
          "mapping-browser.tsx",
        ),
        outputFile: "mapping-browser.tsx",
        outputBase: "components",
      },
    ],
  },
  "plug-debugger": {
    name: "plug-debugger",
    description: "Dev-only debug panel for testing plug requests interactively",
    requiresShadcn: true,
    requires: ["plug"],
    dependencies: {
      shadcnComponents: ["card", "badge", "button", "input", "label"],
    },
    files: [
      {
        templatePath: path.resolve(__dirname, "templates", "api-state.tsx"),
        outputFile: "api-state.tsx",
        outputBase: "components",
      },
      {
        templatePath: path.resolve(__dirname, "templates", "plug-debugger.tsx"),
        outputFile: "plug-debugger.tsx",
        outputBase: "components",
      },
    ],
  },
  catch: {
    name: "catch",
    description: "Durable webhook event processing via Vercel Workflow",
    requires: ["wire"],
    requiresWorkflowIntegration: true,
    dependencies: {
      npmPackages: ["workflow"],
    },
    files: [
      {
        templatePath: path.resolve(__dirname, "templates", "catch.ts"),
        outputFile: "webhooks/catch.ts",
        outputBase: "outputDir",
      },
      {
        templatePath: path.resolve(__dirname, "templates", "catch.example.ts"),
        outputFile: "webhooks/catch.example.ts",
        outputBase: "outputDir",
      },
    ],
  },
  pass: {
    name: "pass",
    description:
      "Durable webhook event forwarding to another service via Vercel Workflow",
    requires: ["wire", "plug"],
    requiresWorkflowIntegration: true,
    dependencies: {
      npmPackages: ["workflow"],
    },
    files: [
      {
        templatePath: path.resolve(__dirname, "templates", "pass.ts"),
        outputFile: "webhooks/pass.ts",
        outputBase: "outputDir",
      },
      {
        templatePath: path.resolve(__dirname, "templates", "pass.example.ts"),
        outputFile: "webhooks/pass.example.ts",
        outputBase: "outputDir",
      },
    ],
  },
  inflow: {
    name: "inflow",
    description:
      "Durable flow for pulling data from a plug into your app via Vercel Workflow",
    requires: ["plug", "schema"],
    requiresWorkflowIntegration: true,
    dependencies: {
      npmPackages: ["workflow"],
    },
    files: [
      {
        templatePath: path.resolve(__dirname, "templates", "inflow.ts"),
        outputFile: "flows/inflow.ts",
        outputBase: "outputDir",
      },
      {
        templatePath: path.resolve(__dirname, "templates", "inflow.example.ts"),
        outputFile: "flows/inflow.example.ts",
        outputBase: "outputDir",
      },
    ],
  },
  outflow: {
    name: "outflow",
    description:
      "Durable flow for pushing app data out through a plug via Vercel Workflow",
    requires: ["plug", "schema"],
    requiresWorkflowIntegration: true,
    dependencies: {
      npmPackages: ["workflow"],
    },
    files: [
      {
        templatePath: path.resolve(__dirname, "templates", "outflow.ts"),
        outputFile: "flows/outflow.ts",
        outputBase: "outputDir",
      },
      {
        templatePath: path.resolve(
          __dirname,
          "templates",
          "outflow.example.ts",
        ),
        outputFile: "flows/outflow.example.ts",
        outputBase: "outputDir",
      },
    ],
  },
  relay: {
    name: "relay",
    description:
      "Durable flow for moving data between plugs via Vercel Workflow",
    requires: ["plug", "schema"],
    requiresWorkflowIntegration: true,
    dependencies: {
      npmPackages: ["workflow"],
    },
    files: [
      {
        templatePath: path.resolve(__dirname, "templates", "relay.ts"),
        outputFile: "flows/relay.ts",
        outputBase: "outputDir",
      },
      {
        templatePath: path.resolve(__dirname, "templates", "relay.example.ts"),
        outputFile: "flows/relay.example.ts",
        outputBase: "outputDir",
      },
    ],
  },
  "agent-skill": {
    name: "agent-skill",
    description:
      "Agent skill that teaches AI agents to use khotan plug for API debugging",
    files: [
      {
        templatePath: path.resolve(__dirname, "templates", "agent-skill.md"),
        outputFile: "khotan-probe",
        outputBase: "agentSkills",
      },
    ],
  },
  "skill-build": {
    name: "skill-build",
    description:
      "Agent skill orchestrating the end-to-end service integration workflow",
    files: [
      {
        templatePath: path.resolve(__dirname, "templates", "skill-build.md"),
        outputFile: "khotan-build",
        outputBase: "agentSkills",
      },
    ],
  },
  "skill-setup": {
    name: "skill-setup",
    description: "Agent skill for setting up khotan-data in a Next.js project",
    files: [
      {
        templatePath: path.resolve(__dirname, "templates", "skill-setup.md"),
        outputFile: "khotan-setup",
        outputBase: "agentSkills",
      },
    ],
  },
  "skill-plug": {
    name: "skill-plug",
    description:
      "Agent skill for creating and configuring khotan Plugs (API clients)",
    files: [
      {
        templatePath: path.resolve(__dirname, "templates", "skill-plug.md"),
        outputFile: "khotan-plug",
        outputBase: "agentSkills",
      },
    ],
  },
  "skill-flow": {
    name: "skill-flow",
    description:
      "Agent skill for building and running flows (inflow, outflow, relay)",
    files: [
      {
        templatePath: path.resolve(__dirname, "templates", "skill-flow.md"),
        outputFile: "khotan-flow",
        outputBase: "agentSkills",
      },
    ],
  },
  "skill-webhook": {
    name: "skill-webhook",
    description:
      "Agent skill for webhook subscriptions with Wires, Catch, and Pass",
    files: [
      {
        templatePath: path.resolve(__dirname, "templates", "skill-webhook.md"),
        outputFile: "khotan-webhook",
        outputBase: "agentSkills",
      },
    ],
  },
  "skill-cache": {
    name: "skill-cache",
    description:
      "Agent skill for first-class durable caching in flows and webhooks",
    files: [
      {
        templatePath: path.resolve(__dirname, "templates", "skill-cache.md"),
        outputFile: "khotan-cache",
        outputBase: "agentSkills",
      },
    ],
  },
  "skill-mappings": {
    name: "skill-mappings",
    description: "Agent skill for resources and cross-service record mappings",
    files: [
      {
        templatePath: path.resolve(__dirname, "templates", "skill-mappings.md"),
        outputFile: "khotan-mappings",
        outputBase: "agentSkills",
      },
    ],
  },
  "skill-frontend": {
    name: "skill-frontend",
    description:
      "Agent skill that suggests khotan frontend components and page blocks",
    files: [
      {
        templatePath: path.resolve(__dirname, "templates", "skill-frontend.md"),
        outputFile: "khotan-frontend",
        outputBase: "agentSkills",
      },
    ],
  },
};

const BLOCKS: Record<string, ComponentEntry> = {
  "config-page-1": {
    name: "config-page-1",
    description: "Page route at /config that renders the KhotanHub dashboard",
    requires: ["hub"],
    files: [
      {
        templatePath: path.resolve(__dirname, "templates", "config-page.tsx"),
        outputFile: "config/page.tsx",
        outputBase: "appRoot",
      },
    ],
  },
  "debug-page-1": {
    name: "debug-page-1",
    description:
      "Debug routes at /debug (plug list) and /debug/[plugName] (debugger)",
    requires: ["plug-debugger"],
    files: [
      {
        templatePath: path.resolve(
          __dirname,
          "templates",
          "debug-index-page.tsx",
        ),
        outputFile: "debug/page.tsx",
        outputBase: "appRoot",
      },
      {
        templatePath: path.resolve(__dirname, "templates", "debug-page.tsx"),
        outputFile: "debug/[plugName]/page.tsx",
        outputBase: "appRoot",
      },
    ],
  },
  "logs-page-1": {
    name: "logs-page-1",
    description:
      "Page route at /logs that renders recent runs and webhook events",
    requires: ["logs"],
    files: [
      {
        templatePath: path.resolve(__dirname, "templates", "logs-page.tsx"),
        outputFile: "logs/page.tsx",
        outputBase: "appRoot",
      },
    ],
  },
  "mappings-page-1": {
    name: "mappings-page-1",
    description:
      "Page route at /mappings that renders the reusable Khotan mappings browser",
    requires: ["mapping-browser"],
    files: [
      {
        templatePath: path.resolve(__dirname, "templates", "mappings-page.tsx"),
        outputFile: "mappings/page.tsx",
        outputBase: "appRoot",
      },
    ],
  },
  graph: {
    name: "graph",
    description:
      "Standalone topology graph page at /graph with filtering and run-state overlays",
    requiresShadcn: true,
    dependencies: {
      npmPackages: ["@xyflow/react"],
      shadcnComponents: ["card", "badge"],
    },
    files: [
      {
        templatePath: path.resolve(__dirname, "templates", "api-state.tsx"),
        outputFile: "api-state.tsx",
        outputBase: "components",
      },
      {
        templatePath: path.resolve(__dirname, "templates", "date-time.tsx"),
        outputFile: "date-time.tsx",
        outputBase: "components",
      },
      {
        templatePath: path.resolve(
          __dirname,
          "templates",
          "topology-canvas.tsx",
        ),
        outputFile: "topology-canvas.tsx",
        outputBase: "components",
      },
      {
        templatePath: path.resolve(__dirname, "templates", "graph-page.tsx"),
        outputFile: "graph/page.tsx",
        outputBase: "appRoot",
      },
    ],
  },
};

export type EntryKind = "component" | "block";

export function getComponent(name: string): ComponentEntry | undefined {
  return COMPONENTS[name];
}

export function getBlock(name: string): ComponentEntry | undefined {
  return BLOCKS[name];
}

export function getEntry(
  name: string,
): { entry: ComponentEntry; kind: EntryKind } | undefined {
  const comp = COMPONENTS[name];
  if (comp) return { entry: comp, kind: "component" };
  const block = BLOCKS[name];
  if (block) return { entry: block, kind: "block" };
  return undefined;
}

export function getTemplateContent(
  entry: ComponentEntry | ComponentFile,
): string {
  const templatePath = "templatePath" in entry ? entry.templatePath : undefined;
  if (!templatePath) {
    throw new Error("No templatePath on entry");
  }
  return fs.readFileSync(templatePath, "utf-8");
}

export function listComponents(): ComponentEntry[] {
  return Object.values(COMPONENTS);
}

export function listBlocks(): ComponentEntry[] {
  return Object.values(BLOCKS);
}

export function isMultiFile(
  entry: ComponentEntry,
): entry is ComponentEntry & { files: ComponentFile[] } {
  return Array.isArray(entry.files) && entry.files.length > 0;
}
