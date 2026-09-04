import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { DbModule } from "../db/db.module.js";
import { TakesModule } from "../takes/takes.module.js";
import { CommentsController } from "./comments.controller.js";
import { commentsServiceProvider } from "./comments.service.js";

@Module({
  imports: [DbModule, AuthModule, TakesModule],
  controllers: [CommentsController],
  providers: [commentsServiceProvider],
})
export class CommentsModule {}
