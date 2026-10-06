import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { DbModule } from "../db/db.module.js";
import { SupportController } from "./support.controller.js";
import { supportServiceProvider } from "./support.service.js";

@Module({
  imports: [DbModule, AuthModule],
  controllers: [SupportController],
  providers: [supportServiceProvider],
})
export class SupportModule {}
