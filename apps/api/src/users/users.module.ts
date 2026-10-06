import { Module } from "@nestjs/common";
import { DbModule } from "../db/db.module.js";
import { StorageModule } from "../storage/storage.module.js";
import { usersServiceProvider, UsersService } from "./users.service.js";

@Module({
  imports: [DbModule, StorageModule],
  providers: [usersServiceProvider],
  exports: [UsersService],
})
export class UsersModule {}
