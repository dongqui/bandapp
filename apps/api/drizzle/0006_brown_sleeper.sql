ALTER TABLE "comments" ADD COLUMN "session_id" uuid;--> statement-breakpoint
-- 손으로 넣음: 기존 코멘트는 전부 take 코멘트 — take의 세션으로 채운다 (2026-09-09 스펙 결정 4)
UPDATE "comments" SET "session_id" = t."session_id" FROM "takes" t WHERE t."id" = "comments"."take_id";--> statement-breakpoint
ALTER TABLE "comments" ALTER COLUMN "session_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "comments" ALTER COLUMN "take_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comments_session_at_idx" ON "comments" USING btree ("session_id","at_ms");
