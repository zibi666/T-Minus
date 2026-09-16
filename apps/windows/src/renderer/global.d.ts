import { TimerDTO, TimerMeta, TickPayload, CreateTimerInput, UpdateTimerPatch, AuthInfo, SyncStatusInfo, RecordDTO } from '../shared/types';

declare global {
  interface Window {
    timemark: {
      list(): Promise<TimerDTO[]>;
      create(input: CreateTimerInput): Promise<TimerDTO | null>;
      update(id: string, patch: UpdateTimerPatch): Promise<TimerDTO | null>;
      start(id: string, payload?: { durationMs?: number }): Promise<TimerDTO | null>;
      pause(id: string): Promise<TimerDTO | null>;
      resume(id: string): Promise<TimerDTO | null>;
      reset(id: string): Promise<TimerDTO | null>;
      segment(id: string): Promise<TimerDTO | null>;
      stop(id: string): Promise<TimerDTO | null>;
      remove(id: string): Promise<boolean>;
      listMetas(): Promise<TimerMeta[]>;
      listRecords(limit?: number): Promise<RecordDTO[]>;
      deleteRecords(ids: string[]): Promise<number>;
      listTags(): Promise<Array<{ id: string; name: string; color: string }>>;
      setTimerTags(id: string, names: string[]): Promise<TimerDTO | null>;
      winControl(action: 'minimize' | 'maximize' | 'close'): Promise<void>;
      exportData(): Promise<{ ok: boolean; filePath?: string }>;
      appVersion(): Promise<string>;
      dataDir(): Promise<{ dir: string; overridden: boolean }>;
      checkUpdate(): Promise<{ hasUpdate: boolean; latest: string; current: string; url: string; checkedAt: number }>;
      openReleasePage(): Promise<{ ok: boolean; url: string }>;
      onUpdateStatus(cb: (s: { hasUpdate: boolean; latest: string; current: string; url: string; checkedAt: number }) => void): () => void;
      onTick(cb: (p: TickPayload) => void): () => void;
      authState(): Promise<AuthInfo>;
      login(serverUrl: string, username: string, password: string): Promise<{ ok: boolean; message?: string }>;
      register(serverUrl: string, username: string, password: string): Promise<{ ok: boolean; message?: string }>;
      logout(): Promise<{ ok: boolean }>;
      syncNow(): Promise<void>;
      syncStatus(): Promise<SyncStatusInfo>;
      onSyncStatus(cb: (s: SyncStatusInfo) => void): () => void;
    };
  }
}

export {};
