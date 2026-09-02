ALTER TABLE "band_invites" DROP CONSTRAINT "band_invites_token_hash_unique";--> statement-breakpoint
ALTER TABLE "band_invites" DROP COLUMN "token_hash";