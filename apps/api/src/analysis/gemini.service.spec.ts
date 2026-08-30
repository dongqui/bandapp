import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GeminiService,
  audioMimeType,
  parseTakes,
  resolveAudioPath,
  type GenAiClient,
} from "./gemini.service.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../../");

describe("resolveAudioPath", () => {
  it("resolves a repo-root-relative path to an absolute path, independent of process.cwd()", () => {
    expect(resolveAudioPath("poc/data/test.wav")).toBe(join(repoRoot, "poc/data/test.wav"));
  });

  it("passes absolute paths through unchanged", () => {
    const absolute = join(repoRoot, "poc/data/test.wav");
    expect(resolveAudioPath(absolute)).toBe(absolute);
  });
});

describe("audioMimeType", () => {
  it("maps known audio extensions", () => {
    expect(audioMimeType("poc/data/a.wav")).toBe("audio/wav");
    expect(audioMimeType("x.mp3")).toBe("audio/mp3");
    expect(audioMimeType("x.m4a")).toBe("audio/mp4");
  });

  it("throws on unsupported extensions", () => {
    expect(() => audioMimeType("notes.txt")).toThrow("unsupported audio extension");
  });
});

describe("parseTakes", () => {
  it("parses a valid takes payload", () => {
    const text = JSON.stringify({
      takes: [{ startMs: 1000, endMs: 5000, type: "PERFORMANCE", confidence: 0.93 }],
    });
    expect(parseTakes(text)).toEqual([
      { startMs: 1000, endMs: 5000, type: "PERFORMANCE", confidence: 0.93 },
    ]);
  });

  it("accepts an empty takes array", () => {
    expect(parseTakes(JSON.stringify({ takes: [] }))).toEqual([]);
  });

  it.each([
    ["not json", "not-json"],
    ["missing takes", JSON.stringify({})],
    ["startMs >= endMs", JSON.stringify({ takes: [{ startMs: 5, endMs: 5, type: "PERFORMANCE", confidence: 0.5 }] })],
    ["bad type enum", JSON.stringify({ takes: [{ startMs: 0, endMs: 5, type: "JAM", confidence: 0.5 }] })],
    ["non-number confidence", JSON.stringify({ takes: [{ startMs: 0, endMs: 5, type: "PERFORMANCE", confidence: "high" }] })],
  ])("throws on invalid payload: %s", (_label, text) => {
    expect(() => parseTakes(text)).toThrow();
  });
});

describe("GeminiService.analyzeAudio", () => {
  const validText = JSON.stringify({
    takes: [{ startMs: 0, endMs: 4000, type: "PERFORMANCE", confidence: 0.9 }],
  });

  function makeClient(overrides: Partial<Record<string, unknown>> = {}): GenAiClient {
    return {
      files: {
        upload: vi.fn().mockResolvedValue({
          name: "files/abc",
          uri: "https://files/abc",
          mimeType: "audio/wav",
          state: "ACTIVE",
          ...(overrides.uploadResult as object),
        }),
        get: (overrides.get as GenAiClient["files"]["get"]) ?? vi.fn(),
      },
      models: {
        generateContent:
          (overrides.generateContent as GenAiClient["models"]["generateContent"]) ??
          vi.fn().mockResolvedValue({ text: validText }),
      },
    };
  }

  beforeEach(() => {
    delete process.env.GEMINI_MODEL;
    delete process.env.GEMINI_TIMEOUT_MS;
  });

  it("uploads the file and returns parsed takes", async () => {
    const client = makeClient();
    const service = new GeminiService(() => client, 1);

    const takes = await service.analyzeAudio("poc/data/test.wav");

    expect(client.files.upload).toHaveBeenCalledWith({
      file: resolveAudioPath("poc/data/test.wav"),
      config: { mimeType: "audio/wav" },
    });
    expect(takes).toEqual([{ startMs: 0, endMs: 4000, type: "PERFORMANCE", confidence: 0.9 }]);
  });

  it("polls until the uploaded file becomes ACTIVE", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ state: "PROCESSING" })
      .mockResolvedValueOnce({ state: "ACTIVE", uri: "https://files/abc", mimeType: "audio/wav" });
    const client = makeClient({ uploadResult: { state: "PROCESSING" }, get });
    const service = new GeminiService(() => client, 1);

    await service.analyzeAudio("a.wav");

    expect(get).toHaveBeenCalledTimes(2);
  });

  it("throws when file processing fails", async () => {
    const get = vi.fn().mockResolvedValue({ state: "FAILED" });
    const client = makeClient({ uploadResult: { state: "PROCESSING" }, get });
    const service = new GeminiService(() => client, 1);

    await expect(service.analyzeAudio("a.wav")).rejects.toThrow("processing failed");
  });

  it("throws when the response is empty", async () => {
    const client = makeClient({ generateContent: vi.fn().mockResolvedValue({ text: undefined }) });
    const service = new GeminiService(() => client, 1);

    await expect(service.analyzeAudio("a.wav")).rejects.toThrow("empty response");
  });

  it("throws without calling the SDK when GEMINI_API_KEY is missing (default factory)", async () => {
    delete process.env.GEMINI_API_KEY;
    const service = new GeminiService();

    await expect(service.analyzeAudio("a.wav")).rejects.toThrow("GEMINI_API_KEY");
  });

  it("times out when the analysis exceeds GEMINI_TIMEOUT_MS", async () => {
    process.env.GEMINI_TIMEOUT_MS = "20";
    const client = makeClient({
      generateContent: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
    });
    const service = new GeminiService(() => client, 1);

    await expect(service.analyzeAudio("a.wav")).rejects.toThrow("timed out");
    delete process.env.GEMINI_TIMEOUT_MS;
  });
});
