export type OnboardingState = "pending_username" | "active";

export interface User {
  id: string;
  username: string;
  displayName: string;
  onboardingState: OnboardingState;
  githubId: string;
  githubLogin: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  onboardingState: OnboardingState;
  githubLogin: string;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    onboardingState: user.onboardingState,
    githubLogin: user.githubLogin,
  };
}
