import type { BandMember } from "@bandapp/types";
import { useRouter } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, View } from "react-native";
import { useApiData } from "@/api";
import { useAuth } from "@/features/auth/AuthProvider";
import { radius, space, useTheme } from "@/theme";
import { AppText, BottomSheet, ConfirmDialog, MonoLabel, PressableOpacity, Screen } from "@/ui";
import { InviteSheet } from "./InviteSheet";
import { MemberRow } from "./MemberRow";
import { MemberSheet } from "./MemberSheet";
import { PartSheet } from "./PartSheet";
import { RenameSheet } from "./RenameSheet";
import { SelfMemberSheet } from "./SelfMemberSheet";
import { TransferSheet } from "./TransferSheet";
import { useBandActions } from "./useBandActions";
import { useCurrentBand } from "./useCurrentBand";

type Sheet =
  | { kind: "self" }
  | { kind: "member"; member: BandMember }
  | { kind: "part" }
  | { kind: "transfer" }
  | { kind: "rename" }
  | { kind: "invite" }
  | null;

type Confirm =
  | { kind: "remove"; member: BandMember }
  | { kind: "transfer"; member: BandMember }
  | { kind: "delete" }
  | { kind: "leave" }
  | { kind: "ownerLeave" }
  | null;

export function BandScreen() {
  const { band } = useCurrentBand();
  const { state } = useAuth();
  const myId = state.status === "authenticated" ? state.user.id : null;
  const { data: members } = useApiData(
    async (api) => (band ? api.bands.members(band.id) : []),
    [band?.id],
  );
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();
  const [sheet, setSheet] = useState<Sheet>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const actions = useBandActions(band);

  const list = members ?? [];
  const me = list.find((m) => m.id === myId) ?? null;
  // 목록을 아직 못 불러왔으면 member로 취급 — owner 전용 UI가 깜빡이며 나타나는 것보다 안전하다
  const isOwner = me?.role === "owner";
  const bandName = band?.name ?? "";
  const others = list.filter((m) => m.id !== myId);

  const close = () => setSheet(null);

  const onLeavePress = () => {
    // 혼자 남은 owner는 이전할 상대가 없으니 TransferSheet 대신 delete 확인으로 보낸다
    if (isOwner && others.length === 0) setConfirm({ kind: "delete" });
    else setConfirm({ kind: isOwner ? "ownerLeave" : "leave" });
  };

  const confirmProps = (() => {
    if (!confirm) return null;
    const cancel = () => setConfirm(null);
    switch (confirm.kind) {
      case "remove":
        return {
          title: t("band.confirm.remove.title", { name: confirm.member.name }),
          body: t("band.confirm.remove.body", { band: bandName }),
          primary: {
            label: t("band.confirm.remove.primary"),
            danger: true,
            onPress: () => void actions.remove(confirm.member).then(cancel),
          },
        };
      case "transfer":
        return {
          title: t("band.confirm.transfer.title", { name: confirm.member.name }),
          body: t("band.confirm.transfer.body"),
          primary: {
            label: t("band.confirm.transfer.primary"),
            onPress: () => void actions.transfer(confirm.member).then(cancel),
          },
        };
      case "delete":
        return {
          title: t("band.confirm.delete.title", { band: bandName }),
          body: t("band.confirm.delete.body"),
          primary: {
            label: t("band.confirm.delete.primary"),
            danger: true,
            // 다이얼로그(Modal)를 먼저 닫아야 router.replace가 띄워진 Modal 아래에서 돌지 않는다
            onPress: () => {
              cancel();
              void actions.deleteBand();
            },
          },
        };
      case "leave":
        return {
          title: t("band.confirm.leave.title", { band: bandName }),
          body: t("band.confirm.leave.body"),
          primary: {
            label: t("band.confirm.leave.primary"),
            danger: true,
            // 다이얼로그를 먼저 닫는다 — ownerMustTransfer면 leave() 응답 후 ownerLeave 다이얼로그를 다시 연다
            onPress: () => {
              cancel();
              void actions.leave().then((result) => {
                if (result === "ownerMustTransfer") setConfirm({ kind: "ownerLeave" });
              });
            },
          },
        };
      case "ownerLeave":
        return {
          title: t("band.confirm.ownerLeave.title"),
          body: t("band.confirm.ownerLeave.body", { band: bandName }),
          primary: {
            label: t("band.confirm.ownerLeave.primary"),
            onPress: () => {
              setConfirm(null);
              setSheet({ kind: "transfer" });
            },
          },
          secondary: {
            label: t("band.confirm.ownerLeave.secondary"),
            onPress: () => setConfirm({ kind: "delete" }),
          },
        };
    }
  })();

  return (
    <Screen>
      <View style={{ paddingHorizontal: space.screenX, paddingBottom: 10, gap: 8 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <MonoLabel color={colors.textMuted} style={{ letterSpacing: 1.8 }}>
            {t("band.header.yourBand")}
          </MonoLabel>
          <PressableOpacity onPress={() => router.push("/settings")} style={{ padding: 4 }}>
            <AppText style={{ fontSize: 16, color: colors.textMuted }}>⚙</AppText>
          </PressableOpacity>
        </View>
        <AppText variant="titleXL">{bandName}</AppText>
        <MonoLabel>{t("band.header.members", { n: band?.memberCount ?? 0 })}</MonoLabel>
      </View>
      <FlatList
        data={list}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ paddingHorizontal: space.screenX, paddingBottom: 160 }}
        renderItem={({ item }) => {
          const isMe = item.id === myId;
          const tappable = isMe || isOwner;
          return (
            <MemberRow
              member={item}
              isMe={isMe}
              tappable={tappable}
              onPress={() => setSheet(isMe ? { kind: "self" } : { kind: "member", member: item })}
            />
          );
        }}
        ListFooterComponent={
          <View>
            {isOwner ? (
              <PressableOpacity
                onPress={() => setSheet({ kind: "invite" })}
                style={{
                  marginTop: 20,
                  borderWidth: 1,
                  borderColor: colors.borderStrong,
                  borderRadius: radius.input,
                  padding: 14,
                  alignItems: "center",
                }}
              >
                <AppText style={{ fontSize: 14, color: colors.accent }}>{t("band.invite.button")}</AppText>
              </PressableOpacity>
            ) : null}
            <MonoLabel style={{ paddingTop: 32, paddingBottom: 4, letterSpacing: 1.6 }}>{t("band.manage.title")}</MonoLabel>
            {isOwner ? (
              <ManageRow
                title={t("band.manage.bandName")}
                value={bandName}
                onPress={() => setSheet({ kind: "rename" })}
              />
            ) : null}
            {isOwner ? (
              <ManageRow title={t("band.manage.transfer")} onPress={() => setSheet({ kind: "transfer" })} />
            ) : null}
            <ManageRow title={t("band.manage.leave")} danger onPress={onLeavePress} />
            {isOwner ? (
              <ManageRow title={t("band.manage.delete")} danger last onPress={() => setConfirm({ kind: "delete" })} />
            ) : null}
          </View>
        }
      />

      {band ? <InviteSheet visible={sheet?.kind === "invite"} onClose={close} bandId={band.id} /> : null}

      {/* 다섯 개 인앱 시트를 한 BottomSheet(=한 Modal)로 호스팅한다 — 시트 사이 전환(예: self → part)이
          Modal을 닫았다 다시 여는 게 아니라 같은 Modal 안에서 내용만 바뀌게 하기 위함이다.
          iOS에서 dismiss와 present가 같은 커밋에서 겹치면 두 번째 present가 조용히 씹힐 수 있다. */}
      <BottomSheet
        visible={sheet !== null && sheet.kind !== "invite"}
        onClose={close}
        title={
          sheet?.kind === "part"
            ? t("band.part.title")
            : sheet?.kind === "transfer"
              ? t("band.transfer.title")
              : sheet?.kind === "rename"
                ? t("band.rename.title")
                : undefined
        }
        subtitle={
          sheet?.kind === "part"
            ? t("band.part.subtitle")
            : sheet?.kind === "transfer"
              ? t("band.transfer.subtitle")
              : undefined
        }
      >
        {sheet?.kind === "self" && me ? (
          <SelfMemberSheet
            me={me}
            isOwner={isOwner}
            onChangePart={() => setSheet({ kind: "part" })}
            onTransfer={() => setSheet({ kind: "transfer" })}
          />
        ) : null}
        {sheet?.kind === "part" ? (
          <PartSheet
            current={me?.part ?? null}
            onSubmit={(part) => {
              close();
              void actions.setPart(part);
            }}
          />
        ) : null}
        {sheet?.kind === "member" ? (
          <MemberSheet
            member={sheet.member}
            onMakeOwner={() => {
              const { member } = sheet;
              close();
              setConfirm({ kind: "transfer", member });
            }}
            onRemove={() => {
              const { member } = sheet;
              close();
              setConfirm({ kind: "remove", member });
            }}
          />
        ) : null}
        {sheet?.kind === "transfer" ? (
          <TransferSheet
            candidates={others}
            onPick={(member) => {
              close();
              setConfirm({ kind: "transfer", member });
            }}
          />
        ) : null}
        {sheet?.kind === "rename" ? (
          <RenameSheet
            initial={bandName}
            onSave={(name) => {
              close();
              void actions.rename(name);
            }}
          />
        ) : null}
      </BottomSheet>

      {confirmProps ? (
        <ConfirmDialog
          visible
          title={confirmProps.title}
          body={confirmProps.body}
          primary={confirmProps.primary}
          secondary={"secondary" in confirmProps ? confirmProps.secondary : undefined}
          cancelLabel={t("common.cancel")}
          onCancel={() => setConfirm(null)}
          busy={actions.busy}
        />
      ) : null}
    </Screen>
  );
}

/** MANAGE 섹션의 행. 디자인: 16px 세로 패딩, 아래 구분선, 우측 값 + chevron. */
function ManageRow({
  title,
  value,
  danger = false,
  last = false,
  onPress,
}: {
  title: string;
  value?: string;
  danger?: boolean;
  last?: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <PressableOpacity
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingVertical: 16,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: colors.border,
      }}
    >
      <AppText style={{ fontSize: 15, color: danger ? colors.danger : colors.text }}>{title}</AppText>
      {danger ? null : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {value ? <AppText style={{ fontSize: 14, color: colors.textMuted }}>{value}</AppText> : null}
          <AppText style={{ fontSize: 18, color: colors.borderHover }}>›</AppText>
        </View>
      )}
    </PressableOpacity>
  );
}
