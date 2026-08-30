import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/db.module.js";

export function createTestDb(): Db {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return drizzle(new pg.Pool({ connectionString: url }), { schema });
}

export async function truncateAll(db: Db): Promise<void> {
  await db.execute(
    sql`TRUNCATE band_invites, band_members, bands, auth_sessions, user_identities, users CASCADE`,
  );
}
