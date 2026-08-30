import { Module } from "@nestjs/common";
import type { Provider } from "@nestjs/common";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { DB } from "./db.constants.js";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

// pg.Pool은 lazy connect라 DATABASE_URL만 있으면 DB 없이도 부팅된다.
export const dbProvider: Provider = {
  provide: DB,
  useFactory: (): Db => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    return drizzle(new pg.Pool({ connectionString: url }), { schema });
  },
};

@Module({ providers: [dbProvider], exports: [DB] })
export class DbModule {}
