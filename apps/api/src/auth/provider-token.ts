export interface VerifiedProviderToken {
  subject: string;
  email: string | null;
  emailVerified: boolean | null;
  displayName: string | null;
  profileImageUrl: string | null;
}
