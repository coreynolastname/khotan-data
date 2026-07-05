import { afterEach, describe, expect, it, vi } from "vitest";
import { varsCommand } from "./commands/plug-vars.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function runPlugVarsAction(args: string[]) {
  const writes: string[] = [];
  const writeSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown) => {
      if (chunk === undefined || chunk === null) return true;
      writes.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
  const exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation((code?: number) => {
      throw new Error(`EXIT:${String(code ?? 0)}`);
    });

  let thrown: unknown = null;
  try {
    await varsCommand.parseAsync(args, { from: "user" });
  } catch (error) {
    thrown = error;
  } finally {
    writeSpy.mockRestore();
    exitSpy.mockRestore();
  }

  const parsed = writes
    .map((w) => w.trim())
    .filter(Boolean)
    .map((w) => JSON.parse(w) as Record<string, unknown>);

  return { parsed, thrown };
}

describe("plug vars command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows variables for a plug", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse([{ name: "pollinate" }]))
      .mockResolvedValueOnce(
        jsonResponse({
          configured: true,
          fields: [
            { key: "apiKey", label: "API Key", type: "password", secret: true },
          ],
          values: { apiKey: "••••••••" },
        }),
      );

    const { parsed, thrown } = await runPlugVarsAction([
      "pollinate",
      "--base-path",
      "/api/khotan",
    ]);

    expect(thrown).toBeNull();
    expect(parsed[0]).toEqual({
      ok: true,
      plugName: "pollinate",
      configured: true,
      fields: [
        { key: "apiKey", label: "API Key", type: "password", secret: true },
      ],
      values: { apiKey: "••••••••" },
    });
  });

  it("sets variables using JSON payload", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse([{ name: "pollinate" }]))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const { parsed, thrown } = await runPlugVarsAction([
      "pollinate",
      "set",
      "--json",
      '{"apiKey":"secret","orgId":"org_123"}',
      "--base-path",
      "/api/khotan",
    ]);

    expect(thrown).toBeNull();
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      "http://localhost:3000/api/khotan/variables/pollinate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ apiKey: "secret", orgId: "org_123" }),
      }),
    );
    expect(parsed[0]).toEqual({
      ok: true,
      action: "set",
      plugName: "pollinate",
    });
  });

  it("sets variables for a named profile", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse([{ name: "pollinate" }]))
      .mockResolvedValueOnce(jsonResponse({ ok: true, profile: "uat" }));

    const { parsed, thrown } = await runPlugVarsAction([
      "pollinate",
      "set",
      "--profile",
      "uat",
      "--json",
      '{"apiKey":"secret"}',
      "--base-path",
      "/api/khotan",
    ]);

    expect(thrown).toBeNull();
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      "http://localhost:3000/api/khotan/variables/pollinate?profile=uat",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ apiKey: "secret" }),
      }),
    );
    expect(parsed[0]).toEqual({
      ok: true,
      action: "set",
      plugName: "pollinate",
      profile: "uat",
    });
  });

  it("lists variable state for all plugs", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse([{ name: "pollinate" }, { name: "shopify" }]),
      )
      .mockResolvedValueOnce(
        jsonResponse([{ name: "pollinate" }, { name: "shopify" }]),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          configured: true,
          fields: [
            { key: "apiKey", label: "API Key", type: "password", secret: true },
          ],
          values: { apiKey: "••••••••" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          configured: false,
          fields: [],
          values: {},
        }),
      );

    const { parsed, thrown } = await runPlugVarsAction([
      "--list",
      "--base-path",
      "/api/khotan",
    ]);

    expect(thrown).toBeNull();
    expect(parsed[0]).toEqual({
      ok: true,
      variables: [
        {
          plugName: "pollinate",
          configured: true,
          fields: [
            { key: "apiKey", label: "API Key", type: "password", secret: true },
          ],
          values: { apiKey: "••••••••" },
        },
        {
          plugName: "shopify",
          configured: false,
          fields: [],
          values: {},
        },
      ],
    });
  });
});

describe("plug vars secret redaction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("redacts secret fields by default", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse([{ name: "pollinate" }]))
      .mockResolvedValueOnce(
        jsonResponse({
          configured: true,
          fields: [
            { key: "apiKey", label: "API Key", type: "password", secret: true },
            { key: "orgId", label: "Org ID", type: "text", secret: false },
          ],
          values: { apiKey: "super-secret-key", orgId: "org_123" },
        }),
      );

    const { parsed, thrown } = await runPlugVarsAction([
      "pollinate",
      "--base-path",
      "/api/khotan",
    ]);

    expect(thrown).toBeNull();
    expect(parsed[0]?.values).toEqual({
      apiKey: "••••••••",
      orgId: "org_123",
    });
  });

  it("reveals secrets with --show-secrets flag", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse([{ name: "pollinate" }]))
      .mockResolvedValueOnce(
        jsonResponse({
          configured: true,
          fields: [
            { key: "apiKey", label: "API Key", type: "password", secret: true },
            { key: "orgId", label: "Org ID", type: "text", secret: false },
          ],
          values: { apiKey: "super-secret-key", orgId: "org_123" },
        }),
      );

    const { parsed, thrown } = await runPlugVarsAction([
      "pollinate",
      "--base-path",
      "/api/khotan",
      "--show-secrets",
    ]);

    expect(thrown).toBeNull();
    expect(parsed[0]?.values).toEqual({
      apiKey: "super-secret-key",
      orgId: "org_123",
    });
  });

  it("redacts fields with type=password even without secret flag", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse([{ name: "pollinate" }]))
      .mockResolvedValueOnce(
        jsonResponse({
          configured: true,
          fields: [{ key: "token", label: "Token", type: "password" }],
          values: { token: "tok_abc123" },
        }),
      );

    const { parsed, thrown } = await runPlugVarsAction([
      "pollinate",
      "--base-path",
      "/api/khotan",
    ]);

    expect(thrown).toBeNull();
    expect(parsed[0]?.values).toEqual({ token: "••••••••" });
  });
});

describe("plug vars CLI auth (security)", () => {
  const originalSecret = process.env["KHOTAN_SECRET"];

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalSecret === undefined) delete process.env["KHOTAN_SECRET"];
    else process.env["KHOTAN_SECRET"] = originalSecret;
  });

  it("attaches a KhotanCLI HMAC auth header on every request when KHOTAN_SECRET is set", async () => {
    process.env["KHOTAN_SECRET"] = "cli-secret-value";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse([{ name: "pollinate" }]))
      .mockResolvedValueOnce(
        jsonResponse({ configured: false, fields: [], values: {} }),
      );

    const { thrown } = await runPlugVarsAction([
      "pollinate",
      "--base-path",
      "/api/khotan",
    ]);

    expect(thrown).toBeNull();
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    for (const call of fetchSpy.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      // Never the raw secret — only a timestamped one-way HMAC.
      expect(headers["Authorization"]).toMatch(/^KhotanCLI \d+\.[0-9a-f]{64}$/);
      expect(JSON.stringify(headers)).not.toContain("cli-secret-value");
    }
  });

  it("sends no auth header when no secret is available", async () => {
    delete process.env["KHOTAN_SECRET"];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse([{ name: "pollinate" }]))
      .mockResolvedValueOnce(
        jsonResponse({ configured: false, fields: [], values: {} }),
      );

    const { thrown } = await runPlugVarsAction([
      "pollinate",
      "--base-path",
      "/api/khotan",
    ]);

    expect(thrown).toBeNull();
    // Connectivity GET is made with a single arg — no init, no headers.
    expect(fetchSpy.mock.calls[0]?.length).toBe(1);
  });

  it("reports a clear unauthorized error when the API returns 401", async () => {
    process.env["KHOTAN_SECRET"] = "cli-secret-value";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ error: "Unauthorized" }, 401),
    );

    const { parsed, thrown } = await runPlugVarsAction([
      "pollinate",
      "--base-path",
      "/api/khotan",
    ]);

    expect(String(thrown)).toContain("EXIT:1");
    expect(parsed[0]).toMatchObject({ ok: false, error: "unauthorized" });
  });
});
