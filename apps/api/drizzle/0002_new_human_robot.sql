--> 손으로 추가: 해시에서 평문 토큰을 복원할 수 없어 기존 초대를 버린다 (스펙 결정 6, 출시 전이라 안전)
DELETE FROM "band_invites";--> statement-breakpoint
CREATE TYPE "public"."band_part" AS ENUM('vocal', 'guitar', 'bass', 'drums', 'keyboard', 'other');--> statement-breakpoint
ALTER TABLE "band_invites" ADD COLUMN "token" text NOT NULL;--> statement-breakpoint
ALTER TABLE "band_members" ADD COLUMN "part" "band_part";--> statement-breakpoint
ALTER TABLE "band_invites" ADD CONSTRAINT "band_invites_token_unique" UNIQUE("token");