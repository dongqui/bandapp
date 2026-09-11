CREATE TYPE "public"."take_audio_status" AS ENUM('ready', 'updating', 'failed');--> statement-breakpoint
ALTER TABLE "takes" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "takes" ADD COLUMN "audio_status" "take_audio_status" DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "takes" ADD COLUMN "audio_error" text;