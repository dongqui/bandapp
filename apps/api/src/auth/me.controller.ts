import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Patch,
  Put,
  UnauthorizedException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { DISPLAY_NAME_MAX, type User } from "@bandapp/types";
import { requireString } from "../common/validation.js";
import { UsersService } from "../users/users.service.js";
import { AppleTokenService } from "./apple-token.service.js";
import { AuthGuard } from "./auth.guard.js";
import { CurrentUserId } from "./current-user-id.decorator.js";

/** 512px JPEG(앱이 리사이즈해서 보낸다)은 100KB 안팎이다. 상한은 리사이즈를 건너뛴 클라이언트 방어용 */
export const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** multer 타입 패키지를 들이지 않으려고 쓰는 부분만 적는다 */
interface UploadedPhoto {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

function requireDisplayName(body: unknown): string {
  const name = requireString(body, "displayName").trim();
  if (name.length === 0 || name.length > DISPLAY_NAME_MAX) {
    throw new BadRequestException(`displayName must be 1-${DISPLAY_NAME_MAX} characters`);
  }
  return name;
}

@Controller("me")
@UseGuards(AuthGuard)
export class MeController {
  constructor(
    private readonly users: UsersService,
    private readonly appleTokens: AppleTokenService,
  ) {}

  @Get()
  async me(@CurrentUserId() userId: string): Promise<User> {
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedException(); // 탈퇴한 계정의 잔여 access token
    return user;
  }

  @Patch()
  updateMe(@CurrentUserId() userId: string, @Body() body: unknown): Promise<User> {
    return this.users.updateDisplayName(userId, requireDisplayName(body));
  }

  /** multipart/form-data, 필드명 photo. jpeg/png/webp */
  @Put("photo")
  @UseInterceptors(FileInterceptor("photo", { limits: { fileSize: PHOTO_MAX_BYTES, files: 1 } }))
  setPhoto(@CurrentUserId() userId: string, @UploadedFile() file: UploadedPhoto | undefined): Promise<User> {
    if (!file || file.size === 0) throw new BadRequestException("photo file is required");
    if (!PHOTO_TYPES.has(file.mimetype)) throw new BadRequestException("photo must be jpeg, png or webp");
    return this.users.setProfilePhoto(userId, file.buffer, file.mimetype);
  }

  @Delete("photo")
  @HttpCode(204)
  async removePhoto(@CurrentUserId() userId: string): Promise<void> {
    await this.users.removeProfilePhoto(userId);
  }

  @Delete()
  @HttpCode(204)
  async deleteMe(@CurrentUserId() userId: string): Promise<void> {
    const { appleRefreshTokens } = await this.users.deleteAccount(userId);
    // 트랜잭션 커밋 후 best-effort. revokeAll이 실패를 자체적으로 삼키므로 여기서 감싸지 않는다.
    await this.appleTokens.revokeAll(appleRefreshTokens);
  }
}
