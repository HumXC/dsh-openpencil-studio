import type { ComponentType, ReactNode } from "react";

export const BRIDGE_KEY = "__DSH_OPENPENCIL_STUDIO_V1__";
export const VIEW_ID = "openpencil-studio";
export const OPEN_ENDPOINT = "/_dsh/openpencil-studio/open";
export const RUNTIME_EVENT = "dsh-openpencil-studio:runtime";
export type Grant = Record<string, unknown> & { sourcePath?: string };
export interface EditorRequest { grant: Grant; sessionId: string; automatic?: boolean }
export interface Lifecycle { phase: string; dirty: boolean }
export interface SelectionCapture {
  documentJson: string; sourcePath: string; activePageId: string; selectedIds: string[];
  revision: number; generation: number; capturedAt: number;
}
export interface InputSpan { start: number; end: number; draftRev: number }
export interface EmptyViewProps { sessionId: string; open(path: string): Promise<void> }
export interface LifecycleController {
  requestClose(): Promise<boolean>;
  awaitExistingSave(): Promise<boolean>;
  captureRecovery(): Promise<boolean>;
  captureSelection?(): Promise<SelectionCapture>;
  retainServerSessionOnUnmount(): void;
}
export interface EditorProps {
  grant: Grant; sessionId: string; colorScheme: string; locale: string;
  allowTakeover: boolean; onLifecycleState(state: Lifecycle): void;
  onLifecycleController(controller: LifecycleController | undefined): void;
  workbenchActions?: ReactNode;
  onReferenceSelection?(): Promise<void>;
}
export interface Runtime {
  Editor: ComponentType<EditorProps>;
  options: { subscribeTheme(fn: () => void): () => void; getColorScheme(): string; subscribeLocale(fn: () => void): () => void; getLocale(): string };
  key(grant: Grant, sessionId: string): string;
  locale(value: string): string;
  preserve(state: Lifecycle, controller: LifecycleController): Promise<string>;
  EmptyView?: ComponentType<EmptyViewProps>;
  onOpened?(request: EditorRequest): Promise<void>;
  reference?(capture: SelectionCapture, sessionId: string, span: InputSpan): Promise<void>;
}
export interface WorkbenchHandler {
  open(request: EditorRequest, automatic: boolean): Promise<boolean>;
  dispose(): Promise<void>;
}
export interface Bridge { version: 1; runtime?: Runtime; handler?: WorkbenchHandler }
export function getBridge(): Bridge {
  const target = globalThis as typeof globalThis & { [BRIDGE_KEY]?: Bridge };
  return target[BRIDGE_KEY] ??= { version: 1 };
}
export function isOpPath(path: string): boolean {
  return path.length > 0 && !path.includes("\0") && !/^[a-z][a-z0-9+.-]*:/i.test(path) && path.toLowerCase().endsWith(".op");
}
