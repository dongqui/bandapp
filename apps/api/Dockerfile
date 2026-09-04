FROM node:22-alpine

RUN corepack enable
# 워커가 청크·take를 잘라내는 데 ffmpeg/ffprobe가 필요하다. api 컨테이너도 같은 이미지를 쓴다.
RUN apk add --no-cache ffmpeg
WORKDIR /app

# 워크스페이스 manifest만 먼저 복사해 install 레이어를 캐시한다.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/mobile/package.json apps/mobile/
COPY packages/types/package.json packages/types/
COPY packages/config/package.json packages/config/
COPY packages/api-client/package.json packages/api-client/

# mobile(Expo) 의존성은 제외하고 api와 그 워크스페이스 의존성만 설치.
RUN pnpm install --frozen-lockfile --filter @bandapp/api...

COPY . .

EXPOSE 3000
CMD ["pnpm", "--filter", "@bandapp/api", "start:api:dev"]
