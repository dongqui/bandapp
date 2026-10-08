#!/usr/bin/env sh
# api 프로덕션 이미지를 빌드해서 ECR에 올린다. 저장소가 없으면 만든다.
#
#   사용법:  sh infra/ecr-push.sh [태그]
#   태그 생략 시 현재 git 커밋 짧은 해시를 쓴다. 같은 이미지를 :latest로도 올린다.
#
#   필요한 것: docker, aws cli v2, `aws login`(또는 프로필) 완료.
#   환경변수로 덮어쓸 수 있는 값: AWS_REGION(기본 ap-northeast-2), ECR_REPO(기본 bandapp-api)
set -eu

cd "$(dirname "$0")/.."

REGION="${AWS_REGION:-ap-northeast-2}"
REPO="${ECR_REPO:-bandapp-api}"
TAG="${1:-$(git rev-parse --short HEAD)}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"

echo "== account $ACCOUNT_ID / region $REGION / repo $REPO / tag $TAG"

# 저장소가 없으면 생성. latest만 덮어쓸 수 있게 두고 나머지 태그는 불변으로 잠근다.
if ! aws ecr describe-repositories --repository-names "$REPO" --region "$REGION" >/dev/null 2>&1; then
  echo "== creating repository $REPO"
  aws ecr create-repository \
    --repository-name "$REPO" \
    --image-tag-mutability IMMUTABLE_WITH_EXCLUSION \
    --image-tag-mutability-exclusion-filters filterType=WILDCARD,filter=latest \
    --encryption-configuration encryptionType=AES256 \
    --region "$REGION" >/dev/null
  # 태그 없는 이미지와 오래된 이미지를 정리해서 저장 비용을 막는다.
  aws ecr put-lifecycle-policy --repository-name "$REPO" --region "$REGION" --lifecycle-policy-text '{
    "rules": [
      {"rulePriority": 1, "description": "untagged after 1 day",
       "selection": {"tagStatus": "untagged", "countType": "sinceImagePushed", "countUnit": "days", "countNumber": 1},
       "action": {"type": "expire"}},
      {"rulePriority": 2, "description": "keep last 20 tagged",
       "selection": {"tagStatus": "any", "countType": "imageCountMoreThan", "countNumber": 20},
       "action": {"type": "expire"}}
    ]}' >/dev/null
fi

echo "== docker login"
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"

echo "== build"
# Fargate 기본 아키텍처(x86_64)에 맞춘다. ARM64(Graviton)로 바꾸려면 태스크 정의와 함께 linux/arm64로.
docker build --platform linux/amd64 -f apps/api/Dockerfile.prod -t "$REPO:$TAG" .

echo "== push"
docker tag "$REPO:$TAG" "$REGISTRY/$REPO:$TAG"
docker tag "$REPO:$TAG" "$REGISTRY/$REPO:latest"
docker push "$REGISTRY/$REPO:$TAG"
docker push "$REGISTRY/$REPO:latest"

echo "== done: $REGISTRY/$REPO:$TAG"
