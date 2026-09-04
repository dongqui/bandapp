import { Module } from "@nestjs/common";
import { StorageService, storageServiceProvider } from "./storage.service.js";

@Module({
  providers: [storageServiceProvider],
  exports: [StorageService],
})
export class StorageModule {}
