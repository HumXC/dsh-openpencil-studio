export interface PresentationGrant {
  sourcePath?: string;
  document?: { path?: string; url: string };
  editor?: { enabled: true; launchUrl: string; refreshUrl?: string };
  image?: { previewUrl: string };
  images?: { previewUrl: string; name: string }[];
}
export const ROUTE = "/_dsh/openpencil-studio";
export interface StudioSnapshot {
  dirty: boolean;
  generation: number;
  revision: number;
  sequence: number;
  phase: string;
  leaseId?: string;
  selection?: unknown;
}
