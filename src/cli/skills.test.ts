import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  listComponents,
  getSkillName,
  type ComponentEntry,
} from "./registry.js";
import {
  installSkills,
  detectAgents,
  type SkillDefinition,
} from "./agent-detect.js";
import { SKILL_COMPONENTS } from "./commands/init.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(__dirname, "templates");
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A registry entry that installs at least one agent skill. */
interface SkillEntry {
  entry: ComponentEntry;
  /** The registry key, e.g. "skill-build" */
  registryName: string;
  /** The installed skill / frontmatter name, e.g. "khotan-build" */
  skillName: string;
  /** Absolute path to the markdown template */
  templatePath: string;
  /** Template basename, e.g. "skill-build.md" */
  templateFile: string;
}

function skillEntries(): SkillEntry[] {
  const out: SkillEntry[] = [];
  for (const entry of listComponents()) {
    const skillName = getSkillName(entry);
    if (!skillName) continue;
    const file = entry.files?.find((f) => f.outputBase === "agentSkills");
    if (!file) continue;
    out.push({
      entry,
      registryName: entry.name,
      skillName,
      templatePath: file.templatePath,
      templateFile: path.basename(file.templatePath),
    });
  }
  return out;
}

function parseFrontmatter(content: string): {
  name?: string;
  hasDescription: boolean;
} {
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!match) return { hasDescription: false };
  const block = match[1] ?? "";
  const nameMatch = /^name:\s*(.+)$/m.exec(block);
  return {
    name: nameMatch?.[1]?.trim(),
    hasDescription: /^description:\s*/m.test(block),
  };
}

const KNOWN_SKILL_NAMES = new Set(skillEntries().map((s) => s.skillName));

// ===========================================================================
// Tier 1 — Static / structural validation
// ===========================================================================

describe("skill templates (static validation)", () => {
  const entries = skillEntries();

  it("registers at least the expected skills", () => {
    expect(entries.length).toBeGreaterThanOrEqual(9);
  });

  it.each(entries)(
    "$registryName: template exists with valid frontmatter",
    ({ templatePath, skillName }) => {
      expect(fs.existsSync(templatePath)).toBe(true);
      const content = fs.readFileSync(templatePath, "utf-8");
      const fm = parseFrontmatter(content);
      expect(fm.name, "frontmatter must declare a name").toBeTruthy();
      expect(fm.hasDescription, "frontmatter must declare a description").toBe(
        true,
      );
      // The frontmatter name must equal the installed skill directory name.
      expect(fm.name).toBe(skillName);
    },
  );

  it("uses unique skill names", () => {
    const names = entries.map((e) => e.skillName);
    expect(new Set(names).size).toBe(names.length);
  });

  it("khotan-flow warns about dispatcher cadence for minute-level schedules", () => {
    const entry = entries.find(
      (candidate) => candidate.registryName === "skill-flow",
    );
    expect(entry).toBeDefined();
    const content = fs.readFileSync(entry!.templatePath, "utf-8");
    expect(content).toContain(
      '{ "crons": [{ "path": "/api/khotan/cron", "schedule": "* * * * *" }] }',
    );
    expect(content).toContain("smallest flow/variant schedule granularity");
    expect(content).toContain("hourly dispatcher");
  });
});

describe("init SKILL_COMPONENTS consistency", () => {
  it("installs exactly the registry's skill entries", () => {
    const registrySkillKeys = skillEntries()
      .map((s) => s.registryName)
      .sort();
    expect([...SKILL_COMPONENTS].sort()).toEqual(registrySkillKeys);
  });

  it("every SKILL_COMPONENTS id resolves to a real template", () => {
    const byName = new Map(skillEntries().map((s) => [s.registryName, s]));
    for (const id of SKILL_COMPONENTS) {
      const entry = byName.get(id);
      expect(entry, `${id} should be a registered skill`).toBeDefined();
      expect(fs.existsSync(entry!.templatePath)).toBe(true);
    }
  });
});

describe("tsup copies every skill template", () => {
  const tsupConfig = fs.readFileSync(
    path.join(REPO_ROOT, "tsup.config.ts"),
    "utf-8",
  );

  it.each(skillEntries())(
    "$templateFile is copied to dist/templates",
    ({ templateFile }) => {
      expect(
        tsupConfig.includes(`"${templateFile}"`),
        `tsup.config.ts must copy ${templateFile}`,
      ).toBe(true);
    },
  );
});

describe("AGENTS.md router lists every skill", () => {
  const agentsMd = fs.readFileSync(
    path.join(TEMPLATES_DIR, "agents.md"),
    "utf-8",
  );

  it("links exactly the installed skills", () => {
    const linked = new Set<string>();
    const re = /skills\/(khotan-[\w-]+)\/SKILL\.md/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(agentsMd)) !== null) {
      if (m[1]) linked.add(m[1]);
    }
    expect([...linked].sort()).toEqual([...KNOWN_SKILL_NAMES].sort());
  });
});

describe("cross-link integrity", () => {
  it.each(skillEntries())(
    "$skillName only references real sibling skills",
    ({ templatePath }) => {
      const content = fs.readFileSync(templatePath, "utf-8");
      // Backticked references like `khotan-flow`. `khotan-data` is the package.
      const re = /`khotan-([a-z-]+)`/g;
      let m: RegExpExecArray | null;
      const dangling: string[] = [];
      while ((m = re.exec(content)) !== null) {
        const name = `khotan-${m[1]}`;
        if (name === "khotan-data") continue;
        if (!KNOWN_SKILL_NAMES.has(name)) dangling.push(name);
      }
      expect(dangling, `dangling skill links: ${dangling.join(", ")}`).toEqual(
        [],
      );
    },
  );
});

// ===========================================================================
// Tier 2 — Install / refresh behavior
// ===========================================================================

function allSkillDefs(): SkillDefinition[] {
  return skillEntries().map((s) => ({
    name: s.skillName,
    templatePath: s.templatePath,
  }));
}

const AGENTS_TEMPLATE = path.join(TEMPLATES_DIR, "agents.md");
const PKG_VERSION = (
  JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8"),
  ) as { version: string }
).version;

describe("detectAgents", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "khotan-skill-detect-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("defaults to cursor + claude when no agent dirs exist", () => {
    const agents = detectAgents(tmp).map((a) => a.agent);
    expect(agents).toEqual(["cursor", "claude"]);
  });

  it("detects only the agents whose marker dirs exist", () => {
    fs.mkdirSync(path.join(tmp, ".cursor"));
    fs.mkdirSync(path.join(tmp, ".github"));
    const agents = detectAgents(tmp)
      .map((a) => a.agent)
      .sort();
    expect(agents).toEqual(["copilot", "cursor"]);
  });
});

describe("installSkills", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "khotan-skill-install-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("creates all skill files for a detected agent plus AGENTS.md", () => {
    fs.mkdirSync(path.join(tmp, ".cursor"));
    const result = installSkills(tmp, allSkillDefs(), AGENTS_TEMPLATE, {
      autoYes: true,
    });

    expect(result.agents).toEqual(["cursor"]);
    for (const skill of allSkillDefs()) {
      const p = path.join(tmp, ".cursor", "skills", skill.name, "SKILL.md");
      expect(fs.existsSync(p), `${skill.name} should be installed`).toBe(true);
    }
    expect(fs.existsSync(path.join(tmp, "AGENTS.md"))).toBe(true);
    expect(result.created).toContain("AGENTS.md");
  });

  it("installs to every detected agent directory", () => {
    fs.mkdirSync(path.join(tmp, ".cursor"));
    fs.mkdirSync(path.join(tmp, ".claude"));
    installSkills(tmp, allSkillDefs(), AGENTS_TEMPLATE, { autoYes: true });

    const first = allSkillDefs()[0]!.name;
    expect(
      fs.existsSync(path.join(tmp, ".cursor", "skills", first, "SKILL.md")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(tmp, ".claude", "skills", first, "SKILL.md")),
    ).toBe(true);
  });

  it("skips files already stamped with the current version", () => {
    fs.mkdirSync(path.join(tmp, ".cursor"));
    installSkills(tmp, allSkillDefs(), AGENTS_TEMPLATE, { autoYes: true });

    const second = installSkills(tmp, allSkillDefs(), AGENTS_TEMPLATE, {
      autoYes: true,
    });
    expect(second.created).toEqual([]);
    expect(second.refreshed).toEqual([]);
    expect(second.skipped.length).toBeGreaterThan(0);
  });

  it("refreshes a skill file with a stale version stamp", () => {
    fs.mkdirSync(path.join(tmp, ".cursor"));
    const defs = allSkillDefs();
    const target = defs[0]!;
    const skillPath = path.join(
      tmp,
      ".cursor",
      "skills",
      target.name,
      "SKILL.md",
    );
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(
      skillPath,
      "<!-- khotan-skill-version: 0.0.0 -->\nstale content",
      "utf-8",
    );

    const result = installSkills(tmp, defs, AGENTS_TEMPLATE, { autoYes: true });
    const rel = path.join(".cursor", "skills", target.name, "SKILL.md");
    expect(result.refreshed).toContain(rel);

    const refreshed = fs.readFileSync(skillPath, "utf-8");
    expect(refreshed).toContain(
      `<!-- khotan-skill-version: ${PKG_VERSION} -->`,
    );
    expect(refreshed).not.toContain("stale content");
  });
});
