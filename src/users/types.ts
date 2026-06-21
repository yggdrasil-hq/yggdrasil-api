export type OnboardingState = "pending_username" | "active";

export interface User {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string | null;
  onboardingState: OnboardingState;
  githubId: string | null;
  githubLogin: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  onboardingState: OnboardingState;
  hasPassword: boolean;
  githubConnected: boolean;
  githubLogin: string | null;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    onboardingState: user.onboardingState,
    hasPassword: user.passwordHash !== null,
    githubConnected: user.githubId !== null,
    githubLogin: user.githubLogin,
  };
}
