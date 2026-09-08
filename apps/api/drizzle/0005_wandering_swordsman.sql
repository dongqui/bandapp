ALTER TABLE "band_members" ALTER COLUMN "part" SET DATA TYPE text;--> statement-breakpoint
-- 손으로 넣음: 'other'는 자유 입력이 생겨 의미가 없다 — NULL(미설정)로 (2026-09-08 스펙 결정 1)
UPDATE "band_members" SET "part" = NULL WHERE "part" = 'other';--> statement-breakpoint
DROP TYPE "public"."band_part";--> statement-breakpoint
ALTER TABLE "bands" ADD COLUMN "deleted_at" timestamp with time zone;
