import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Plug,
  PlugError,
  apiKey,
  authorizationCode,
  basic,
  bearer,
  cursorPagination,
  custom,
  envelopePagination,
  hmacSignature,
  jsonApiPagination,
  keysetPagination,
  linkPagination,
  offsetPagination,
  plug,
  tokenCacheStore,
  tokenExchange,
} from "./plug.js";

const BASE = "https://api.example.com";

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("plug factory", () => {
  it("returns a Plug instance", () => {
    const w = plug({ baseUrl: BASE });
    expect(w).toBeInstanceOf(Plug);
  });

  it("exposes baseUrl and authType getters", () => {
    const w = plug({ baseUrl: BASE, auth: bearer("token") });
    expect(w.baseUrl).toBe(BASE);
    expect(w.authType).toBe("bearer");
  });

  it("returns 'none' authType when no auth configured", () => {
    const w = plug({ baseUrl: BASE });
    expect(w.authType).toBe("none");
  });

  it("exposes all HTTP methods and helpers", () => {
    const w = plug({ baseUrl: BASE });
    expect(typeof w.get).toBe("function");
    expect(typeof w.post).toBe("function");
    expect(typeof w.batchPost).toBe("function");
    expect(typeof w.put).toBe("function");
    expect(typeof w.patch).toBe("function");
    expect(typeof w.delete).toBe("function");
    expect(typeof w.request).toBe("function");
    expect(typeof w.paginate).toBe("function");
    expect(typeof w.withAuth).toBe("function");
  });
});

describe("auth strategies", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ ok: true }));
  });
  afterEach(() => vi.restoreAllMocks());

  it("bearer — sets Authorization header with static token", async () => {
    const w = plug({
      baseUrl: BASE,
      auth: bearer("sk_live_123"),
      retry: false,
    });
    await w.get("/test");
    const call = vi.mocked(fetch).mock.calls[0];
    const headers = call[1]!.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer sk_live_123");
  });

  it("bearer — calls token function for dynamic tokens", async () => {
    const tokenFn = vi.fn().mockResolvedValue("dynamic_token");
    const w = plug({ baseUrl: BASE, auth: bearer(tokenFn), retry: false });
    await w.get("/test");
    expect(tokenFn).toHaveBeenCalled();
    const headers = vi.mocked(fetch).mock.calls[0][1]!.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer dynamic_token");
  });

  it("basic — sets Base64-encoded Authorization header", async () => {
    const w = plug({
      baseUrl: BASE,
      auth: basic("user", "pass"),
      retry: false,
    });
    await w.get("/test");
    const headers = vi.mocked(fetch).mock.calls[0][1]!.headers as Headers;
    expect(headers.get("Authorization")).toBe("Basic dXNlcjpwYXNz");
  });

  it("apiKey — sets custom header by default", async () => {
    const w = plug({
      baseUrl: BASE,
      auth: apiKey("X-API-Key", "key_123"),
      retry: false,
    });
    await w.get("/test");
    const headers = vi.mocked(fetch).mock.calls[0][1]!.headers as Headers;
    expect(headers.get("X-API-Key")).toBe("key_123");
  });

  it("apiKey — appends query param when in=query", async () => {
    const w = plug({
      baseUrl: BASE,
      auth: apiKey("api_key", "key_123", { in: "query" }),
      retry: false,
    });
    await w.get("/test");
    const url = vi.mocked(fetch).mock.calls[0][0] as string;
    expect(url).toContain("api_key=key_123");
  });

  it("apiKey — exposes typed query auth metadata", () => {
    const auth = apiKey("api_key", "key_123", { in: "query" });
    expect(auth.queryParam).toEqual({ name: "api_key", value: "key_123" });
  });

  it("custom — calls the provided function with headers", async () => {
    const fn = vi.fn((headers: Headers) => {
      headers.set("X-Signature", "sig_abc");
    });
    const w = plug({ baseUrl: BASE, auth: custom(fn), retry: false });
    await w.get("/test");
    expect(fn).toHaveBeenCalled();
    const headers = vi.mocked(fetch).mock.calls[0][1]!.headers as Headers;
    expect(headers.get("X-Signature")).toBe("sig_abc");
  });

  it("hmacSignature — signs with resolved URL, query, method, body, and vars", async () => {
    const sign = vi.fn((ctx) =>
      [
        ctx.method,
        ctx.url,
        ctx.query,
        JSON.stringify(ctx.body),
        ctx.vars["secret"],
      ].join("|"),
    );
    const w = plug({
      baseUrl: BASE,
      auth: hmacSignature({
        algorithm: "sha256",
        header: "api-auth-signature",
        sign,
      }),
      retry: false,
    });

    await w.post("/orders", {
      params: { page: 1, status: "open" },
      body: { sku: "abc" },
      vars: { secret: "shh" },
    });

    expect(sign).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        url: `${BASE}/orders?page=1&status=open`,
        query: "page=1&status=open",
        body: { sku: "abc" },
        vars: { secret: "shh" },
      }),
    );
    const headers = vi.mocked(fetch).mock.calls[0][1]!.headers as Headers;
    expect(headers.get("api-auth-signature")).toBe(
      'POST|https://api.example.com/orders?page=1&status=open|page=1&status=open|{"sku":"abc"}|shh',
    );
  });

  it("tokenExchange — reports its auth type without coercion", () => {
    const w = plug({
      baseUrl: BASE,
      auth: tokenExchange({
        getVariables: () => ({}),
        tokenEndpoint: "/oauth/token",
        buildTokenRequest: () => ({}),
        parseTokenResponse: () => ({ accessToken: "token" }),
      }),
      retry: false,
    });
    expect(w.authType).toBe("tokenExchange");
  });

  it("tokenExchange — scopes token requests and stores by vars plus request profile", async () => {
    const durableTokens = new Map<string, { accessToken: string }>();
    const buildTokenRequest = vi.fn((vars, context) => ({
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: vars["clientId"]!,
        client_secret: vars["clientSecret"]!,
        org_id: vars["orgId"]!,
        profile: context.profile ?? "",
        request_path: new URL(context.url).pathname,
      }),
    }));

    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url) === `${BASE}/oauth/token`) {
        const body = init?.body as URLSearchParams;
        return jsonResponse({
          access_token: `${body.get("profile")}:${body.get("org_id")}`,
          expires_in: 3600,
        });
      }

      const headers = init?.headers as Headers;
      return jsonResponse({
        ok: true,
        authorization: headers.get("Authorization"),
      });
    });

    const w = plug({
      name: "fresh",
      baseUrl: BASE,
      retry: false,
      auth: tokenExchange({
        getVariables: () => ({
          clientId: "env-client",
          clientSecret: "env-secret",
        }),
        tokenEndpoint: "/oauth/token",
        cacheKey: (vars, context) =>
          `${context.plugName}:${context.profile}:${vars["orgId"]}`,
        buildTokenRequest,
        parseTokenResponse: (data) => {
          const value = data as { access_token: string; expires_in: number };
          return {
            accessToken: value.access_token,
            expiresIn: value.expires_in,
          };
        },
        tokenStore: {
          get: (key) => durableTokens.get(key ?? "") ?? null,
          set: (token, key) => {
            durableTokens.set(key ?? "", token);
          },
        },
      }),
    });

    const first = await w.get<{ authorization: string }>("/items", {
      vars: { orgId: "org-uat" },
      profile: "uat",
    });
    const second = await w.get<{ authorization: string }>("/items", {
      vars: { orgId: "org-live" },
      profile: "live",
    });

    expect(first.authorization).toBe("Bearer uat:org-uat");
    expect(second.authorization).toBe("Bearer live:org-live");
    expect(buildTokenRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "env-client",
        clientSecret: "env-secret",
        orgId: "org-uat",
      }),
      expect.objectContaining({
        plugName: "fresh",
        profile: "uat",
        target: "uat",
        method: "GET",
        url: `${BASE}/items`,
        cacheKey: "fresh:uat:org-uat",
      }),
    );
    expect([...durableTokens.keys()].sort()).toEqual([
      "fresh:live:org-live",
      "fresh:uat:org-uat",
    ]);
  });

  it("tokenExchange — reloads keyed tokens from a durable tokenStore", async () => {
    const durableTokens = new Map([
      ["fresh:uat:org-1", { accessToken: "stored-token" }],
    ]);
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ ok: true }));

    const w = plug({
      name: "fresh",
      baseUrl: BASE,
      retry: false,
      auth: tokenExchange({
        tokenEndpoint: "/oauth/token",
        cacheKey: (vars, context) =>
          `${context.plugName}:${context.profile}:${vars["orgId"]}`,
        buildTokenRequest: () => {
          throw new Error("token endpoint should not be called");
        },
        parseTokenResponse: () => ({ accessToken: "unused" }),
        tokenStore: {
          get: (key) => durableTokens.get(key ?? "") ?? null,
          set: (token, key) => {
            durableTokens.set(key ?? "", token);
          },
        },
      }),
    });

    await w.get("/items", { vars: { orgId: "org-1" }, profile: "uat" });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/items`,
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
    const headers = vi.mocked(fetch).mock.calls[0]![1]!.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer stored-token");
  });

  it("tokenCacheStore — adapts a Khotan cache to a tokenStore", async () => {
    const values = new Map<string, unknown>();
    const cache = {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      set: vi.fn(async (key: string, value: unknown) => {
        values.set(key, value);
        return value;
      }),
      delete: vi.fn(async (key: string) => {
        values.delete(key);
      }),
    };
    const store = tokenCacheStore(cache, { prefix: "oauth:" });

    await store.set({ accessToken: "token-1" }, "fresh:uat");
    await expect(store.get("fresh:uat")).resolves.toEqual({
      accessToken: "token-1",
    });
    await store.clear?.("fresh:uat");

    expect(cache.set).toHaveBeenCalledWith("oauth:fresh:uat", {
      accessToken: "token-1",
    });
    expect(cache.delete).toHaveBeenCalledWith("oauth:fresh:uat");
    await expect(store.get("fresh:uat")).resolves.toBeNull();
  });
});

describe("HTTP methods", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ id: "123" }),
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("GET sends correct method and URL", async () => {
    const w = plug({ baseUrl: BASE, retry: false });
    await w.get("/users/123");
    const call = vi.mocked(fetch).mock.calls[0];
    expect(call[0]).toBe(`${BASE}/users/123`);
    expect(call[1]!.method).toBe("GET");
  });

  it("POST sends JSON body with Content-Type header", async () => {
    const w = plug({ baseUrl: BASE, retry: false });
    await w.post("/users", { body: { name: "Alice" } });
    const call = vi.mocked(fetch).mock.calls[0];
    expect(call[1]!.method).toBe("POST");
    expect(call[1]!.body).toBe('{"name":"Alice"}');
    const headers = call[1]!.headers as Headers;
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("appends query parameters to the URL", async () => {
    const w = plug({ baseUrl: BASE, retry: false });
    await w.get("/users", { params: { page: 1, limit: 10 } });
    const url = vi.mocked(fetch).mock.calls[0][0] as string;
    expect(url).toContain("page=1");
    expect(url).toContain("limit=10");
  });

  it("merges per-request headers with defaults (per-request wins)", async () => {
    const w = plug({
      baseUrl: BASE,
      retry: false,
      defaultHeaders: { "X-Default": "yes", "X-Override": "default" },
    });
    await w.get("/test", { headers: { "X-Override": "custom" } });
    const headers = vi.mocked(fetch).mock.calls[0][1]!.headers as Headers;
    expect(headers.get("X-Default")).toBe("yes");
    expect(headers.get("X-Override")).toBe("custom");
  });

  it("response is typed and parsed as JSON", async () => {
    const w = plug({ baseUrl: BASE, retry: false });
    const result = await w.get<{ id: string }>("/users/123");
    expect(result).toEqual({ id: "123" });
  });

  it("batchPost posts records in fixed-size batches", async () => {
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(jsonResponse({ ok: true })),
    );
    const w = plug({ baseUrl: BASE, retry: false });
    const result = await w.batchPost<{ ok: true }, { id: number }>(
      "/products",
      [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }],
      { batchSize: 2 },
    );

    expect(result).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(vi.mocked(fetch).mock.calls.map((call) => call[1]!.body)).toEqual([
      '[{"id":1},{"id":2}]',
      '[{"id":3},{"id":4}]',
      '[{"id":5}]',
    ]);
  });

  it("batchPost can shape each request body", async () => {
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(jsonResponse({ ok: true })),
    );
    const w = plug({ baseUrl: BASE, retry: false });

    await w.batchPost("/products", [{ id: 1 }, { id: 2 }], {
      batchSize: 2,
      buildBody: (records) => ({ products: records }),
    });

    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.body).toBe(
      '{"products":[{"id":1},{"id":2}]}',
    );
  });
});

describe("retry logic", () => {
  afterEach(() => vi.restoreAllMocks());

  it("retries on 500 and succeeds on later attempt", async () => {
    const mock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("Internal Server Error", { status: 500 }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const w = plug({
      baseUrl: BASE,
      retry: { attempts: 3, backoff: 1 },
    });

    const result = await w.get("/test");
    expect(result).toEqual({ ok: true });
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("throws after all retries are exhausted", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Server Error", { status: 500 }),
    );

    const w = plug({
      baseUrl: BASE,
      retry: { attempts: 3, backoff: 1 },
    });

    await expect(w.get("/test")).rejects.toThrow(PlugError);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("respects Retry-After header on 429", async () => {
    const start = Date.now();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("Rate limited", {
          status: 429,
          headers: { "Retry-After": "0" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const w = plug({
      baseUrl: BASE,
      retry: { attempts: 3, backoff: 1 },
    });

    await w.get("/test");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
  });

  it("does not retry when retry is false", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Error", { status: 500 }),
    );

    const w = plug({ baseUrl: BASE, retry: false });
    await expect(w.get("/test")).rejects.toThrow(PlugError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry non-retryable status codes", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Not Found", { status: 404 }),
    );

    const w = plug({
      baseUrl: BASE,
      retry: { attempts: 3, backoff: 1 },
    });

    await expect(w.get("/test")).rejects.toThrow(PlugError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries when shouldRetry marks a 200 response as throttled", async () => {
    const mock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          data: null,
          extensions: {
            cost: { throttleStatus: { currentlyAvailable: 10 } },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: { products: [] },
          extensions: {
            cost: { throttleStatus: { currentlyAvailable: 100 } },
          },
        }),
      );

    const w = plug({
      baseUrl: BASE,
      retry: { attempts: 3, backoff: 1 },
      shouldRetry: (_response, body) =>
        (
          (body as Record<string, unknown>)["extensions"] as {
            cost?: { throttleStatus?: { currentlyAvailable?: number } };
          }
        )?.cost?.throttleStatus?.currentlyAvailable !== undefined &&
        ((
          (body as Record<string, unknown>)["extensions"] as {
            cost?: { throttleStatus?: { currentlyAvailable?: number } };
          }
        ).cost?.throttleStatus?.currentlyAvailable ?? 0) < 50,
    });

    await expect(w.get("/graphql")).resolves.toEqual({
      data: { products: [] },
      extensions: {
        cost: { throttleStatus: { currentlyAvailable: 100 } },
      },
    });
    expect(mock).toHaveBeenCalledTimes(2);
  });
});

describe("timeout", () => {
  afterEach(() => vi.restoreAllMocks());

  it("aborts requests that exceed the timeout", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = (init as RequestInit)?.signal;
          if (signal) {
            signal.addEventListener("abort", () => {
              reject(
                new DOMException("The operation was aborted.", "AbortError"),
              );
            });
          }
        }),
    );

    const w = plug({ baseUrl: BASE, retry: false, timeout: 50 });
    await expect(w.get("/slow")).rejects.toThrow("Request timed out");
  });
});

describe("error handling", () => {
  afterEach(() => vi.restoreAllMocks());

  it("throws PlugError with status, body, url, and method", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"error":"not_found"}', {
        status: 404,
        statusText: "Not Found",
        headers: { "Content-Type": "application/json" },
      }),
    );

    const w = plug({ baseUrl: BASE, retry: false });
    try {
      await w.get("/missing");
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PlugError);
      const err = e as PlugError;
      expect(err.status).toBe(404);
      expect(err.statusText).toBe("Not Found");
      expect(err.body).toBe('{"error":"not_found"}');
      expect(err.url).toContain("/missing");
      expect(err.method).toBe("GET");
    }
  });
});

describe("withAuth", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(jsonResponse({ ok: true })),
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("returns a new instance with swapped auth", async () => {
    const original = plug({
      baseUrl: BASE,
      auth: bearer("original_token"),
      retry: false,
    });
    const swapped = original.withAuth(bearer("new_token"));

    await original.get("/test");
    const originalHeaders = vi.mocked(fetch).mock.calls[0][1]!
      .headers as Headers;
    expect(originalHeaders.get("Authorization")).toBe("Bearer original_token");

    await swapped.get("/test");
    const swappedHeaders = vi.mocked(fetch).mock.calls[1][1]!
      .headers as Headers;
    expect(swappedHeaders.get("Authorization")).toBe("Bearer new_token");
  });
});

describe("custom content-type parsers", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses registered parser when content-type matches", async () => {
    const xmlText = "<root><id>42</id></root>";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(xmlText, {
        status: 200,
        headers: { "Content-Type": "application/xml" },
      }),
    );

    const parseXml = vi.fn((text: string) => ({ parsed: text }));
    const w = plug({
      baseUrl: BASE,
      retry: false,
      parsers: { "application/xml": parseXml },
    });

    const result = await w.get("/data");
    expect(parseXml).toHaveBeenCalledWith(xmlText);
    expect(result).toEqual({ parsed: xmlText });
  });

  it("falls back to text when no parser matches", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("plain text", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      }),
    );

    const w = plug({
      baseUrl: BASE,
      retry: false,
      parsers: { "application/xml": () => ({}) },
    });

    const result = await w.get("/data");
    expect(result).toBe("plain text");
  });

  it("JSON still handled by default even with parsers configured", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ id: "123" }),
    );

    const parseXml = vi.fn();
    const w = plug({
      baseUrl: BASE,
      retry: false,
      parsers: { "application/xml": parseXml },
    });

    const result = await w.get("/data");
    expect(result).toEqual({ id: "123" });
    expect(parseXml).not.toHaveBeenCalled();
  });
});

describe("pagination", () => {
  afterEach(() => vi.restoreAllMocks());

  it("cursor pagination iterates pages correctly", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ id: 1 }, { id: 2 }], meta: { cursor: "abc" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ id: 3 }], meta: { cursor: null } }),
      );

    const w = plug({
      baseUrl: BASE,
      retry: false,
      pagination: cursorPagination({
        cursorParam: "cursor",
        cursorPath: "meta.cursor",
        dataPath: "data",
      }),
    });

    const pages: unknown[][] = [];
    for await (const page of w.paginate("/items")) {
      pages.push(page);
    }

    expect(pages).toHaveLength(2);
    expect(pages[0]).toEqual([{ id: 1 }, { id: 2 }]);
    expect(pages[1]).toEqual([{ id: 3 }]);
  });

  it("offset pagination stops when page is smaller than pageSize", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 1 }, { id: 2 }] }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 3 }] }));

    const w = plug({
      baseUrl: BASE,
      retry: false,
      pagination: offsetPagination({
        dataPath: "items",
        pageSize: 2,
      }),
    });

    const pages: unknown[][] = [];
    for await (const page of w.paginate("/items")) {
      pages.push(page);
    }

    expect(pages).toHaveLength(2);
    expect(pages[0]).toEqual([{ id: 1 }, { id: 2 }]);
    expect(pages[1]).toEqual([{ id: 3 }]);
  });

  it("keyset pagination uses last item id as cursor", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "a" }, { id: "b" }] }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));

    const w = plug({
      baseUrl: BASE,
      retry: false,
      pagination: keysetPagination({
        param: "starting_after",
        idField: "id",
        dataPath: "data",
      }),
    });

    const pages: unknown[][] = [];
    for await (const page of w.paginate("/items")) {
      pages.push(page);
    }

    expect(pages).toHaveLength(1);
    expect(pages[0]).toEqual([{ id: "a" }, { id: "b" }]);

    const secondUrl = vi.mocked(fetch).mock.calls[1][0] as string;
    expect(secondUrl).toContain("starting_after=b");
  });

  it("supports an inline inspector with an absolute next URL", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: 1 }],
          links: { next: "https://api.example.com/v2/items?cursor=abc" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ id: 2 }], links: { next: null } }),
      );

    const w = plug({ baseUrl: BASE, retry: false });

    const pages: unknown[][] = [];
    for await (const page of w.paginate("/items", {
      getItems: (response) => response["data"] as unknown[],
      hasMore: (response) =>
        Boolean((response["links"] as { next?: string | null }).next),
      getNext: (response) =>
        (response["links"] as { next?: string | null }).next,
    })) {
      pages.push(page);
    }

    expect(pages).toEqual([[{ id: 1 }], [{ id: 2 }]]);
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe(
      "https://api.example.com/v2/items?cursor=abc",
    );
  });

  it("waits interPageDelayMs between page requests", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          jsonResponse({
            data: [{ id: 1 }],
            links: { next: "/items?page=2" },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({ data: [{ id: 2 }], links: { next: null } }),
        );

      const w = plug({
        baseUrl: BASE,
        retry: false,
        pagination: linkPagination({
          linksPath: "links.next",
          dataPath: "data",
          interPageDelayMs: 100,
        }),
      });

      const iterator = w.paginate("/items")[Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toEqual({
        done: false,
        value: [{ id: 1 }],
      });

      const second = iterator.next();
      await vi.advanceTimersByTimeAsync(99);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);

      await expect(second).resolves.toEqual({
        done: false,
        value: [{ id: 2 }],
      });
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("link pagination follows next links", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ id: 1 }], links: { next: "/items?page=2" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ id: 2 }], links: { next: null } }),
      );

    const w = plug({
      baseUrl: BASE,
      retry: false,
      pagination: linkPagination({ linksPath: "links.next", dataPath: "data" }),
    });

    const pages: unknown[][] = [];
    for await (const page of w.paginate("/items")) {
      pages.push(page);
    }

    expect(pages).toEqual([[{ id: 1 }], [{ id: 2 }]]);
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe(`${BASE}/items?page=2`);
  });

  it("jsonApi pagination increments the configured page param", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ id: 1 }], meta: { page: { lastPage: 2 } } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ id: 2 }], meta: { page: { lastPage: 2 } } }),
      );

    const w = plug({
      baseUrl: BASE,
      retry: false,
      pagination: jsonApiPagination({
        pageParam: "page[number]",
        lastPagePath: "meta.page.lastPage",
      }),
    });

    const pages: unknown[][] = [];
    for await (const page of w.paginate("/items")) {
      pages.push(page);
    }

    expect(pages).toEqual([[{ id: 1 }], [{ id: 2 }]]);
    const secondUrl = vi.mocked(fetch).mock.calls[1][0] as string;
    expect(secondUrl).toContain("page%5Bnumber%5D=2");
  });

  it("envelope pagination advances offsets while hasMore is true", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({ items: [{ id: 1 }], hasMore: true }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ items: [{ id: 2 }], hasMore: false }),
      );

    const w = plug({ baseUrl: BASE, retry: false });

    const pages: unknown[][] = [];
    for await (const page of w.paginate("/items", {
      params: { limit: 1 },
      pagination: envelopePagination({
        itemsPath: "items",
        hasMorePath: "hasMore",
        offsetParam: "offset",
      }),
    })) {
      pages.push(page);
    }

    expect(pages).toEqual([[{ id: 1 }], [{ id: 2 }]]);
    const secondUrl = vi.mocked(fetch).mock.calls[1][0] as string;
    expect(secondUrl).toContain("limit=1");
    expect(secondUrl).toContain("offset=1");
  });

  it("throws when paginate is called without a pagination strategy", async () => {
    const w = plug({ baseUrl: BASE, retry: false });
    const iter = w.paginate("/items");
    await expect(
      (async () => {
        for await (const _page of iter) {
          // consume
        }
      })(),
    ).rejects.toThrow("Pagination strategy must be configured");
  });
});

describe("dynamic baseUrl (per-environment)", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ ok: true }));
  });
  afterEach(() => vi.restoreAllMocks());

  it("resolves baseUrl from a function of the request's bound vars", async () => {
    const w = plug({
      baseUrl: (vars: Record<string, string>) =>
        vars["host"] ?? "https://default.example.com",
      retry: false,
    });
    await w.get("/items", { vars: { host: "https://live.example.com" } });
    const url = vi.mocked(fetch).mock.calls[0][0] as string;
    expect(url).toBe("https://live.example.com/items");
  });

  it("falls back to the function's default when no var is provided", async () => {
    const w = plug({
      baseUrl: (vars: Record<string, string>) =>
        vars["host"] ?? "https://default.example.com",
      retry: false,
    });
    await w.get("/items");
    const url = vi.mocked(fetch).mock.calls[0][0] as string;
    expect(url).toBe("https://default.example.com/items");
  });
});

describe("custom auth receives bound vars", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ ok: true }));
  });
  afterEach(() => vi.restoreAllMocks());

  it("passes the request's vars to a custom() strategy", async () => {
    const w = plug({
      baseUrl: BASE,
      auth: custom((headers, vars) => {
        headers.set("Authorization", `Bearer ${vars?.["token"] ?? "none"}`);
      }),
      retry: false,
    });
    await w.get("/test", { vars: { token: "from_vars_123" } });
    const headers = vi.mocked(fetch).mock.calls[0][1]!.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer from_vars_123");
  });
});

describe("tokenExchange body encoding", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends a URLSearchParams token body verbatim with the caller's Content-Type", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ access_token: "tok_abc" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const w = plug({
      baseUrl: BASE,
      auth: tokenExchange({
        getVariables: () => ({ clientId: "id", clientSecret: "secret" }),
        tokenEndpoint: "/oauth/token",
        buildTokenRequest: (vars) => ({
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: vars["clientId"]!,
            client_secret: vars["clientSecret"]!,
          }),
        }),
        parseTokenResponse: (data) => ({
          accessToken: (data as { access_token: string }).access_token,
        }),
      }),
      retry: false,
    });

    await w.get("/test");

    const tokenCall = fetchSpy.mock.calls[0];
    expect(tokenCall[0]).toBe(`${BASE}/oauth/token`);
    const tokenInit = tokenCall[1]!;
    // Body is forwarded as URLSearchParams, NOT JSON.stringify'd.
    expect(tokenInit.body).toBeInstanceOf(URLSearchParams);
    expect((tokenInit.body as URLSearchParams).get("grant_type")).toBe(
      "client_credentials",
    );
    expect((tokenInit.headers as Headers).get("Content-Type")).toBe(
      "application/x-www-form-urlencoded",
    );
    // The actual request then carries the bearer token from the exchange.
    const apiHeaders = fetchSpy.mock.calls[1][1]!.headers as Headers;
    expect(apiHeaders.get("Authorization")).toBe("Bearer tok_abc");
  });

  it("still JSON-encodes a plain object token body with a default Content-Type", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ access_token: "tok_json" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const w = plug({
      baseUrl: BASE,
      auth: tokenExchange({
        getVariables: () => ({ key: "v" }),
        tokenEndpoint: "/oauth/token",
        buildTokenRequest: (vars) => ({ body: { key: vars["key"] } }),
        parseTokenResponse: (data) => ({
          accessToken: (data as { access_token: string }).access_token,
        }),
      }),
      retry: false,
    });

    await w.get("/test");

    const tokenInit = fetchSpy.mock.calls[0][1]!;
    expect(tokenInit.body).toBe(JSON.stringify({ key: "v" }));
    expect((tokenInit.headers as Headers).get("Content-Type")).toBe(
      "application/json",
    );
  });

  it("loads a persisted token from tokenStore across auth instances", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({ access_token: "persisted_tok", expires_in: 3600 }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    let stored: {
      accessToken: string;
      expiresAt?: number;
      refreshToken?: string;
      tokenType?: string;
    } | null = null;
    const tokenStore = {
      get: vi.fn(() => stored),
      set: vi.fn((token: NonNullable<typeof stored>) => {
        stored = token;
      }),
      clear: vi.fn(() => {
        stored = null;
      }),
    };
    const buildAuth = () =>
      tokenExchange({
        getVariables: () => ({ clientId: "id" }),
        tokenEndpoint: "/oauth/token",
        tokenStore,
        buildTokenRequest: () => ({
          body: { grant_type: "client_credentials" },
        }),
        parseTokenResponse: (data) => ({
          accessToken: (data as { access_token: string }).access_token,
          expiresIn: (data as { expires_in: number }).expires_in,
        }),
      });

    await plug({ baseUrl: BASE, auth: buildAuth(), retry: false }).get("/one");
    await plug({ baseUrl: BASE, auth: buildAuth(), retry: false }).get("/two");

    expect(tokenStore.set).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy.mock.calls[0][0]).toBe(`${BASE}/oauth/token`);
    expect(fetchSpy.mock.calls[2][0]).toBe(`${BASE}/two`);
    const secondHeaders = fetchSpy.mock.calls[2][1]!.headers as Headers;
    expect(secondHeaders.get("Authorization")).toBe("Bearer persisted_tok");
  });
});

describe("authorizationCode auth", () => {
  afterEach(() => vi.restoreAllMocks());

  it("builds a PKCE authorization URL and exchanges the code for a bearer token", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "oauth_access",
          refresh_token: "oauth_refresh",
          expires_in: 3600,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    let stored: {
      accessToken: string;
      expiresAt?: number;
      refreshToken?: string;
      tokenType?: string;
    } | null = null;
    const auth = authorizationCode({
      authorizationEndpoint: "/oauth/authorize",
      tokenEndpoint: "/oauth/token",
      clientId: "client_123",
      redirectUri: "https://app.example.com/callback",
      scopes: ["offline_access", "mail.read"],
      pkce: { challengeMethod: "plain" },
      tokenStore: {
        get: () => stored,
        set: (token) => {
          stored = token;
        },
      },
    });
    const w = plug({ baseUrl: BASE, auth, retry: false });

    const authorization = await auth.getAuthorizationUrl({
      state: "state_123",
      codeVerifier: "verifier_123",
    });
    const authorizationUrl = new URL(authorization.url);
    expect(authorizationUrl.pathname).toBe("/oauth/authorize");
    expect(authorizationUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizationUrl.searchParams.get("client_id")).toBe("client_123");
    expect(authorizationUrl.searchParams.get("scope")).toBe(
      "offline_access mail.read",
    );
    expect(authorizationUrl.searchParams.get("code_challenge")).toBe(
      "verifier_123",
    );
    expect(authorization.codeVerifier).toBe("verifier_123");

    await auth.exchangeCode("code_abc", { codeVerifier: "verifier_123" });
    const tokenCall = fetchSpy.mock.calls[0];
    expect(tokenCall[0]).toBe(`${BASE}/oauth/token`);
    const tokenBody = tokenCall[1]!.body as URLSearchParams;
    expect(tokenBody.get("grant_type")).toBe("authorization_code");
    expect(tokenBody.get("code")).toBe("code_abc");
    expect(tokenBody.get("code_verifier")).toBe("verifier_123");

    await w.get("/me");
    const apiHeaders = fetchSpy.mock.calls[1][1]!.headers as Headers;
    expect(apiHeaders.get("Authorization")).toBe("Bearer oauth_access");
    expect(stored?.refreshToken).toBe("oauth_refresh");
  });

  it("refreshes an expired stored authorization-code token before a request", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({ access_token: "fresh_access", expires_in: 3600 }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    let stored: {
      accessToken: string;
      expiresAt?: number;
      refreshToken?: string;
      tokenType?: string;
    } | null = {
      accessToken: "expired_access",
      expiresAt: Date.now() - 1000,
      refreshToken: "refresh_123",
    };
    const auth = authorizationCode({
      authorizationEndpoint: "/oauth/authorize",
      tokenEndpoint: "/oauth/token",
      clientId: "client_123",
      clientSecret: "secret_123",
      redirectUri: "https://app.example.com/callback",
      tokenStore: {
        get: () => stored,
        set: (token) => {
          stored = token;
        },
      },
    });

    await plug({ baseUrl: BASE, auth, retry: false }).get("/me");

    const refreshBody = fetchSpy.mock.calls[0][1]!.body as URLSearchParams;
    expect(refreshBody.get("grant_type")).toBe("refresh_token");
    expect(refreshBody.get("refresh_token")).toBe("refresh_123");
    expect(refreshBody.get("client_secret")).toBe("secret_123");
    const apiHeaders = fetchSpy.mock.calls[1][1]!.headers as Headers;
    expect(apiHeaders.get("Authorization")).toBe("Bearer fresh_access");
    expect(stored?.refreshToken).toBe("refresh_123");
  });

  it("uses request vars for authorization-code credentials during a 401 refresh retry", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({ error: "expired" }, { status: 401 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ access_token: "tenant_fresh", expires_in: 3600 }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    let stored: {
      accessToken: string;
      expiresAt?: number;
      refreshToken?: string;
      tokenType?: string;
    } | null = {
      accessToken: "tenant_stale",
      expiresAt: Date.now() + 3600_000,
      refreshToken: "refresh_tenant",
    };
    const auth = authorizationCode({
      getVariables: () => ({
        clientId: "global_client",
        clientSecret: "global_secret",
        redirectUri: "https://global.example.com/callback",
      }),
      authorizationEndpoint: "/oauth/authorize",
      tokenEndpoint: "/oauth/token",
      clientId: (vars) => vars["clientId"]!,
      clientSecret: (vars) => vars["clientSecret"]!,
      redirectUri: (vars) => vars["redirectUri"]!,
      includeRedirectUriOnRefresh: true,
      tokenStore: {
        get: () => stored,
        set: (token) => {
          stored = token;
        },
      },
    });

    await plug({ baseUrl: BASE, auth, retry: false }).get("/me", {
      vars: {
        clientId: "tenant_client",
        clientSecret: "tenant_secret",
        redirectUri: "https://tenant.example.com/callback",
      },
    });

    const firstHeaders = fetchSpy.mock.calls[0][1]!.headers as Headers;
    expect(firstHeaders.get("Authorization")).toBe("Bearer tenant_stale");
    const refreshBody = fetchSpy.mock.calls[1][1]!.body as URLSearchParams;
    expect(refreshBody.get("grant_type")).toBe("refresh_token");
    expect(refreshBody.get("refresh_token")).toBe("refresh_tenant");
    expect(refreshBody.get("client_id")).toBe("tenant_client");
    expect(refreshBody.get("client_secret")).toBe("tenant_secret");
    expect(refreshBody.get("redirect_uri")).toBe(
      "https://tenant.example.com/callback",
    );
    expect(refreshBody.get("client_id")).not.toBe("global_client");
    expect(refreshBody.get("client_secret")).not.toBe("global_secret");
    expect(refreshBody.get("redirect_uri")).not.toBe(
      "https://global.example.com/callback",
    );
    const retriedHeaders = fetchSpy.mock.calls[2][1]!.headers as Headers;
    expect(retriedHeaders.get("Authorization")).toBe("Bearer tenant_fresh");
    expect(stored?.refreshToken).toBe("refresh_tenant");
  });
});
