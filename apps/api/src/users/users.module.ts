import { Module } from "@nestjs/common";
import { DbModule } from "../db/db.module.js";
import { usersServiceProvider, UsersService } from "./users.service.js";

@Module({
  imports: [DbModule],
  providers: [usersServiceProvider],
  exports: [UsersService],
})
export class UsersModule {}
