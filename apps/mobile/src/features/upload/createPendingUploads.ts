/**
 * 앱 종료 후 이어 올리기용 로컬 스토어 (2026-09-10 업로드 재개 스펙 결정 1·7·8·9).
 * documentDirectory/uploads/ 한 폴더에 옮겨 둔 녹음 파일(<name>.m4a)과 레코드(pending.json)를 함께 둔다 —
 * 폴더가 곧 정리 단위라 고아 정리는 "레코드가 가리키지 않는 파일 삭제"로 끝난다.
 * 파일 시스템은 주입받는다: 네이티브는 expo-file-system/legacy, 웹과 테스트는 메모리 구현.
 * react-native를 import하지 않는다 — 순수 vitest에서 돌아야 한다.
 */
export interface PendingUpload {
  sessionId: string;
  bandId: string;
  fileUri: string;
  source: "recording" | "import";
  /** ISO 8601 */
  createdAt: string;
}

export interface UploadFs {
  documentDirectory: string | null;
  moveAsync(o: { from: string; to: string }): Promise<void>;
  deleteAsync(uri: string, o?: { idempotent?: boolean }): Promise<void>;
  readAsStringAsync(uri: string): Promise<string>;
  writeAsStringAsync(uri: string, contents: string): Promise<void>;
  makeDirectoryAsync(uri: string, o?: { intermediates?: boolean }): Promise<void>;
  readDirectoryAsync(uri: string): Promise<string[]>;
  getInfoAsync(uri: string): Promise<{ exists: boolean }>;
}

export interface PendingUploadsStore {
  /** 캐시의 파일을 uploads/<name>.m4a로 옮기고 새 URI를 돌려준다. 실패하면 throw — 호출자가 원래 URI로 진행한다. */
  stage(uri: string): Promise<string>;
  add(rec: PendingUpload): Promise<void>;
  get(sessionId: string): Promise<PendingUpload | null>;
  list(): Promise<PendingUpload[]>;
  /** 레코드와 파일을 지운다. 어느 쪽이 없어도 조용히 성공한다. */
  discard(sessionId: string): Promise<void>;
  /** 레코드 없이 옮겨 둔 파일만 지운다 (create 전에 실패한 경로). */
  dropFile(uri: string): Promise<void>;
  /** 레코드가 가리키지 않는 uploads/*.m4a를 지운다. 앱 시작 시 한 번 부른다. */
  sweepOrphans(): Promise<void>;
}

const INDEX_NAME = "pending.json";

const warn = (what: string, err: unknown) =>
  console.warn(`[pendingUploads] ${what}: ${err instanceof Error ? err.message : String(err)}`);

function isRecord(v: unknown): v is PendingUpload {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.sessionId === "string" && typeof r.fileUri === "string" && typeof r.bandId === "string";
}

function baseName(uri: string): string {
  return uri.slice(uri.lastIndexOf("/") + 1);
}

export function createPendingUploads(fs: UploadFs): PendingUploadsStore {
  // documentDirectory가 null인 환경(웹)은 메모리 fs를 물려 쓰므로 여기서는 항상 문자열이지만 방어한다
  const dir = `${fs.documentDirectory ?? "memory:///"}uploads/`;
  const indexUri = dir + INDEX_NAME;

  const ensureDir = async () => {
    if (!(await fs.getInfoAsync(dir)).exists) await fs.makeDirectoryAsync(dir, { intermediates: true });
  };

  const readIndex = async (): Promise<Record<string, PendingUpload>> => {
    try {
      if (!(await fs.getInfoAsync(indexUri)).exists) return {};
      const parsed: unknown = JSON.parse(await fs.readAsStringAsync(indexUri));
      if (typeof parsed !== "object" || parsed === null) return {};
      const out: Record<string, PendingUpload> = {};
      for (const [k, v] of Object.entries(parsed)) if (isRecord(v)) out[k] = v;
      return out;
    } catch (err) {
      warn("read index failed, treating as empty", err);
      return {};
    }
  };

  const writeIndex = async (map: Record<string, PendingUpload>) => {
    await ensureDir();
    await fs.writeAsStringAsync(indexUri, JSON.stringify(map));
  };

  const list = async (): Promise<PendingUpload[]> => Object.values(await readIndex());

  return {
    async stage(uri) {
      await ensureDir();
      // crypto.randomUUID는 Hermes에 없다 — 충돌만 피하면 되는 이름이라 시각+난수로 충분하다
      const name = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}.m4a`;
      const to = dir + name;
      await fs.moveAsync({ from: uri, to });
      return to;
    },
    async add(rec) {
      try {
        const map = await readIndex();
        map[rec.sessionId] = rec;
        await writeIndex(map);
      } catch (err) {
        warn(`add ${rec.sessionId} failed`, err);
      }
    },
    async get(sessionId) {
      return (await readIndex())[sessionId] ?? null;
    },
    list,
    async discard(sessionId) {
      try {
        const map = await readIndex();
        const rec = map[sessionId];
        if (rec) await fs.deleteAsync(rec.fileUri, { idempotent: true }).catch((err) => warn(`delete ${rec.fileUri} failed`, err));
        if (sessionId in map) {
          delete map[sessionId];
          await writeIndex(map);
        }
      } catch (err) {
        warn(`discard ${sessionId} failed`, err);
      }
    },
    async dropFile(uri) {
      try {
        await fs.deleteAsync(uri, { idempotent: true });
      } catch (err) {
        warn(`drop ${uri} failed`, err);
      }
    },
    async sweepOrphans() {
      try {
        if (!(await fs.getInfoAsync(dir)).exists) return;
        const referenced = new Set((await list()).map((r) => baseName(r.fileUri)));
        for (const name of await fs.readDirectoryAsync(dir)) {
          if (name === INDEX_NAME || referenced.has(name)) continue;
          await fs.deleteAsync(dir + name, { idempotent: true }).catch((err) => warn(`sweep ${name} failed`, err));
        }
      } catch (err) {
        warn("sweep failed", err);
      }
    },
  };
}

/**
 * 메모리 파일 시스템 — 웹 프리뷰(documentDirectory가 null)와 테스트용. 디렉터리는 접두어로만 흉내 낸다.
 * documentDirectory는 "file:///docs/"로 고정해 테스트가 경로를 예측할 수 있게 한다.
 */
export function createMemoryFs(initial: Record<string, string> = {}): UploadFs & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial));
  const dirs = new Set<string>();
  const isDir = (uri: string) => dirs.has(uri) || [...files.keys()].some((k) => k.startsWith(uri));
  return {
    files,
    documentDirectory: "file:///docs/",
    async moveAsync({ from, to }) {
      const body = files.get(from);
      if (body === undefined) throw new Error(`memory fs: no such file ${from}`);
      files.delete(from);
      files.set(to, body);
    },
    async deleteAsync(uri, o) {
      if (!files.delete(uri) && !o?.idempotent) throw new Error(`memory fs: no such file ${uri}`);
    },
    async readAsStringAsync(uri) {
      const body = files.get(uri);
      if (body === undefined) throw new Error(`memory fs: no such file ${uri}`);
      return body;
    },
    async writeAsStringAsync(uri, contents) {
      files.set(uri, contents);
    },
    async makeDirectoryAsync(uri) {
      dirs.add(uri);
    },
    async readDirectoryAsync(uri) {
      return [...files.keys()].filter((k) => k.startsWith(uri)).map((k) => k.slice(uri.length)).filter((n) => !n.includes("/"));
    },
    async getInfoAsync(uri) {
      return { exists: files.has(uri) || isDir(uri) };
    },
  };
}
