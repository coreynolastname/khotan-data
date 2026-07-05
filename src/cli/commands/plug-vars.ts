import { Command } from "commander";
import { cliFetch } from "../cli-auth.js";
import { output, fail, resolvePort, checkConnectivity } from "../cli-api.js";

interface VariablesResponse {
  fields: {
    key: string;
    label: string;
    type: "text" | "password" | "url";
    secret?: boolean;
    hidden?: boolean;
    required?: boolean;
    placeholder?: string;
    defaultValue?: string;
  }[];
  values: Record<string, string>;
  configured: boolean;
  profile?: string;
}

/**
 * Redact values for fields marked as `secret: true`. Pass `--show-secrets`
 * to reveal them.
 */
function redactSecrets(
  fields: VariablesResponse["fields"],
  values: Record<string, string>,
  showSecrets: boolean,
): Record<string, string> {
  if (showSecrets) return values;
  const redacted: Record<string, string> = {};
  const secretKeys = new Set(
    fields
      .filter((f) => (f.secret ?? false) || f.type === "password")
      .map((f) => f.key),
  );
  for (const [key, value] of Object.entries(values)) {
    redacted[key] = secretKeys.has(key) ? "••••••••" : value;
  }
  return redacted;
}

export const varsCommand = new Command("vars")
  .description("View and manage plug variables via the running Khotan API")
  .argument("[plugName]", "Name of the plug whose variables you want to manage")
  .argument("[action]", "Action: show | set | clear")
  .option("--port <port>", "Dev server port")
  .option("--base-path <path>", "API base path", "/api/khotan")
  .option("--list", "List all plugs and their variable state")
  .option("--json <json>", "Variable payload for set (JSON object)")
  .option("--profile <profile>", "Named variable profile to read/write")
  .option("--target <target>", "Alias for --profile")
  .option(
    "--show-secrets",
    "Show secret values in plaintext (redacted by default)",
  )
  .action(
    async (
      plugName: string | undefined,
      action: string | undefined,
      opts: {
        port?: string;
        basePath: string;
        list?: boolean;
        json?: string;
        profile?: string;
        target?: string;
        showSecrets?: boolean;
      },
      command: Command,
    ) => {
      // `--port` may be parsed onto the parent `plug` command (commander routes
      // it there when it precedes the `vars` subcommand), so merge globals
      // rather than reading only this subcommand's own `opts.port`.
      const { port: portFlag } = command.optsWithGlobals<{ port?: string }>();
      const port = resolvePort(portFlag);
      const baseUrl = `http://localhost:${String(port)}${opts.basePath}`;
      const showSecrets = opts.showSecrets ?? false;
      const selectedProfile = opts.profile ?? opts.target;

      function variablesUrl(name: string): string {
        const url = new URL(`${baseUrl}/variables/${name}`);
        if (selectedProfile) url.searchParams.set("profile", selectedProfile);
        return url.toString();
      }

      await checkConnectivity(baseUrl);

      if (opts.list) {
        const plugsRes = await cliFetch(`${baseUrl}/plugs`);
        const plugs = (await plugsRes.json()) as { name: string }[];
        const variables = await Promise.all(
          plugs.map(async (plug) => {
            const res = await cliFetch(variablesUrl(plug.name));
            if (res.status === 404) {
              return {
                plugName: plug.name,
                ...(selectedProfile ? { profile: selectedProfile } : {}),
                configured: false,
                fields: [],
                values: {},
              };
            }
            const data = (await res.json()) as VariablesResponse;
            return {
              plugName: plug.name,
              ...(data.profile ? { profile: data.profile } : {}),
              configured: data.configured,
              fields: data.fields,
              values: redactSecrets(data.fields, data.values, showSecrets),
            };
          }),
        );
        output({ ok: true, variables });
        return;
      }

      if (!plugName) {
        fail(
          "missing_plug",
          "Usage: khotan plug vars <plugName> [show|set|clear] or khotan plug vars --list",
        );
      }

      const resolvedAction = action ?? "show";

      if (resolvedAction === "show") {
        const res = await cliFetch(variablesUrl(plugName));
        if (res.status === 404) {
          fail("plug_not_found", `Plug "${plugName}" not found.`);
        }
        const data = (await res.json()) as VariablesResponse;
        output({
          ok: true,
          plugName,
          ...(data.profile ? { profile: data.profile } : {}),
          configured: data.configured,
          fields: data.fields,
          values: redactSecrets(data.fields, data.values, showSecrets),
        });
        return;
      }

      if (resolvedAction === "set") {
        if (!opts.json) {
          fail(
            "missing_json",
            'Provide --json with a JSON object. Example: khotan plug vars myPlug set --json \'{"apiKey":"..."}\'',
          );
        }

        let payload: Record<string, string>;
        try {
          payload = JSON.parse(opts.json) as Record<string, string>;
        } catch {
          fail("invalid_json", "Could not parse --json as JSON.");
        }

        const res = await cliFetch(variablesUrl(plugName), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          fail(
            "set_failed",
            data.error ?? `Failed to set variables for "${plugName}"`,
          );
        }
        output({
          ok: true,
          action: "set",
          plugName,
          ...(selectedProfile ? { profile: selectedProfile } : {}),
        });
        return;
      }

      if (resolvedAction === "clear") {
        const res = await cliFetch(variablesUrl(plugName), {
          method: "DELETE",
        });
        if (!res.ok && res.status !== 204) {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          fail(
            "clear_failed",
            data.error ?? `Failed to clear variables for "${plugName}"`,
          );
        }
        output({
          ok: true,
          action: "clear",
          plugName,
          ...(selectedProfile ? { profile: selectedProfile } : {}),
        });
        return;
      }

      fail(
        "invalid_action",
        `Unknown action "${resolvedAction}". Use show, set, clear, or --list.`,
      );
    },
  );
