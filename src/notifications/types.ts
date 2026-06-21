export interface Notification {
  id: string;
  userId: string;
  projectId: string | null;
  kind: string;
  title: string;
  body: string | null;
  linkPath: string | null;
  readAt: Date | null;
  createdAt: Date;
}

export interface PublicNotification {
  id: string;
  projectId: string | null;
  kind: string;
  title: string;
  body: string | null;
  linkPath: string | null;
  readAt: string | null;
  createdAt: string;
}

export function toPublicNotification(notification: Notification): PublicNotification {
  return {
    id: notification.id,
    projectId: notification.projectId,
    kind: notification.kind,
    title: notification.title,
    body: notification.body,
    linkPath: notification.linkPath,
    readAt: notification.readAt?.toISOString() ?? null,
    createdAt: notification.createdAt.toISOString(),
  };
}
