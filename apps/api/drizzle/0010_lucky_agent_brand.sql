CREATE TYPE "public"."billing_store" AS ENUM('app_store', 'play_store');--> statement-breakpoint
CREATE TYPE "public"."charge_state" AS ENUM('reserved', 'charged', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."pool_plan" AS ENUM('band', 'plus');--> statement-breakpoint
CREATE TYPE "public"."pool_status" AS ENUM('active', 'grace', 'expired');--> statement-breakpoint
ALTER TYPE "public"."session_status" ADD VALUE 'waiting_for_time' BEFORE 'failed';--> statement-breakpoint
CREATE TABLE "analysis_charges" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"band_id" uuid NOT NULL,
	"pool_id" uuid,
	"free_sec" integer DEFAULT 0 NOT NULL,
	"monthly_sec" integer DEFAULT 0 NOT NULL,
	"extra_sec" integer DEFAULT 0 NOT NULL,
	"state" charge_state NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"app_user_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"plan" "pool_plan",
	"status" "pool_status" DEFAULT 'expired' NOT NULL,
	"store" "billing_store",
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"will_renew" boolean DEFAULT false NOT NULL,
	"used_sec" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_pools_owner_user_id_unique" UNIQUE("owner_user_id")
);
--> statement-breakpoint
CREATE TABLE "extra_purchases" (
	"transaction_id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"band_id" uuid,
	"sec" integer NOT NULL,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bands" ADD COLUMN "pool_id" uuid;--> statement-breakpoint
ALTER TABLE "bands" ADD COLUMN "free_used_sec" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bands" ADD COLUMN "extra_sec" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "analysis_charges" ADD CONSTRAINT "analysis_charges_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_charges" ADD CONSTRAINT "analysis_charges_band_id_bands_id_fk" FOREIGN KEY ("band_id") REFERENCES "public"."bands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_charges" ADD CONSTRAINT "analysis_charges_pool_id_billing_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."billing_pools"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_pools" ADD CONSTRAINT "billing_pools_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extra_purchases" ADD CONSTRAINT "extra_purchases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extra_purchases" ADD CONSTRAINT "extra_purchases_band_id_bands_id_fk" FOREIGN KEY ("band_id") REFERENCES "public"."bands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bands" ADD CONSTRAINT "bands_pool_id_billing_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."billing_pools"("id") ON DELETE set null ON UPDATE no action;