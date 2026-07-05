import { drizzle } from "drizzle-orm/pglite";
import { pgTable, text } from "drizzle-orm/pg-core";
import {
  drizzleAdapter,
  inflow,
  type FlowRegistration,
  type KhotanAdapter,
  type KhotanConfig,
  type PlugRegistration,
} from "../factory.js";
import * as khotanSchema from "./schema.js";

const appUsers = pgTable("app_users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
});

const appSchema = {
  ...khotanSchema,
  appUsers,
};

interface UserSyncBody {
  cursor: string;
}

const typedFlows: FlowRegistration<UserSyncBody>[] = [
  inflow<UserSyncBody>({
    name: "sync-users",
    resource: "users",
    workflow: async ({ body }) => ({
      status: "completed",
      metadata: { cursor: body?.cursor ?? null },
    }),
  }),
];

export function acceptsAppDrizzleSchema(): KhotanAdapter {
  const db = drizzle.mock({ schema: appSchema });
  return drizzleAdapter(db);
}

export function acceptsTypedFlowArrays(
  adapter: KhotanAdapter,
  plug: PlugRegistration["plug"],
): KhotanConfig {
  const appPlug = {
    name: "app",
    plug,
    flows: typedFlows,
  } satisfies PlugRegistration;

  return {
    adapter,
    plugs: [appPlug],
    authorize: false,
  } satisfies KhotanConfig;
}
