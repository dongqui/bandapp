/** 타입 원본. ko.ts는 이 모양을 그대로 따라야 한다 (2026-09-08 스펙 결정 9). */
export const en = {
  common: {
    cancel: "Cancel",
    save: "Save",
    you: "(You)",
  },
  band: {
    header: {
      yourBand: "YOUR BAND",
      members: "MEMBERS · {{n}}",
    },
    invite: {
      button: "+ Invite member",
      title: "Invite your band",
      subtitle: "Send a link to invite members.",
      copy: "Copy link",
      copied: "Copied",
    },
    manage: {
      title: "MANAGE",
      bandName: "Band name",
      transfer: "Transfer ownership",
      leave: "Leave band",
      delete: "Delete band",
    },
    role: {
      owner: "Owner",
      member: "Member",
    },
    part: {
      title: "Your part",
      subtitle: "Shown next to your name in the band.",
      placeholder: "Or type your own — e.g. Synth, Sax…",
      none: "No part set",
      preset: {
        vocal: "Vocals",
        guitar: "Guitar",
        bass: "Bass",
        drums: "Drums",
        keyboard: "Keys",
      },
    },
    self: {
      changePart: "Change part",
      transfer: "Transfer ownership",
      transferSubtitle: "Hand the owner role to another member",
    },
    member: {
      makeOwner: "Make owner",
      makeOwnerSubtitle: "Transfer ownership of the band",
      remove: "Remove from band",
    },
    transfer: {
      title: "Transfer ownership",
      subtitle: "The new owner manages members and band settings.",
    },
    rename: {
      title: "Band name",
    },
    confirm: {
      remove: {
        title: "Remove {{name}}?",
        body: "They’ll lose access to all of {{band}}’s sessions and feedback. You can invite them again later.",
        primary: "Remove",
      },
      transfer: {
        title: "Make {{name}} the owner?",
        body: "They’ll manage members and band settings. You’ll become a member.",
        primary: "Transfer ownership",
      },
      delete: {
        title: "Delete {{band}}?",
        body: "All sessions, takes, and feedback will be permanently deleted for every member. This can’t be undone.",
        primary: "Delete band",
      },
      leave: {
        title: "Leave {{band}}?",
        body: "You’ll lose access to its sessions and feedback. You can rejoin with an invite link.",
        primary: "Leave band",
      },
      ownerLeave: {
        title: "Transfer ownership first",
        body: "You’re the owner of {{band}}. To leave, hand ownership to another member — or delete the band.",
        primary: "Transfer ownership",
        secondary: "Delete band",
      },
    },
    toast: {
      removed: "{{name}} removed from the band",
      transferred: "{{name}} is now the owner",
      deleted: "Band deleted",
      left: "You left {{band}}",
      renamed: "Band renamed",
      partSet: "Part set to {{part}}",
    },
  },
  errors: {
    generic: "Something went wrong. Please try again.",
    band_forbidden: "You no longer have access to this band.",
    band_owner_only: "Only the band owner can do that.",
    band_owner_must_transfer: "Transfer ownership or delete the band first.",
    band_member_not_found: "That member isn’t in the band anymore.",
    band_cannot_remove_self: "You can’t remove yourself. Use Leave band instead.",
    band_cannot_remove_owner: "The owner can’t be removed.",
    band_transfer_self: "You’re already the owner.",
    invite_not_found: "This invite link isn’t valid.",
    invite_revoked: "This invite link is no longer active.",
    invite_expired: "This invite link has expired.",
    invite_exhausted: "This invite link has been used up.",
  },
};
