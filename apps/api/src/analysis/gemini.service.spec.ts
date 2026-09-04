import {
  GeminiService,
  audioMimeType,
  parseTakes,
  type GenAiClient,
} from "./gemini.service.js";

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
    ["top-level null", "null"],
    ["missing takes", JSON.stringify({})],
    ["startMs >= endMs", JSON.stringify({ takes: [{ startMs: 5, endMs: 5, type: "PERFORMANCE", confidence: 0.5 }] })],
    ["bad type enum", JSON.stringify({ takes: [{ startMs: 0, endMs: 5, type: "JAM", confidence: 0.5 }] })],
    ["non-number confidence", JSON.stringify({ takes: [{ startMs: 0, endMs: 5, type: "PERFORMANCE", confidence: "high" }] })],
  ])("throws on invalid payload: %s", (_label, text) => {
    expect(() => parseTakes(text)).toThrow();
  });
});

describe("GeminiService.analyzeFile", () => {
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
        delete: (overrides.delete as GenAiClient["files"]["delete"]) ?? vi.fn().mockResolvedValue({}),
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

  afterEach(() => {
    delete process.env.GEMINI_MODEL;
    delete process.env.GEMINI_TIMEOUT_MS;
    delete process.env.GEMINI_API_KEY;
  });

  it("uploads the file and returns parsed takes", async () => {
    const client = makeClient();
    const service = new GeminiService(() => client, 1);

    const takes = await service.analyzeFile("/tmp/a.wav");

    expect(client.files.upload).toHaveBeenCalledWith({
      file: "/tmp/a.wav",
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

    await service.analyzeFile("/tmp/a.wav");

    expect(get).toHaveBeenCalledTimes(2);
  });

  it("throws when file processing fails", async () => {
    const get = vi.fn().mockResolvedValue({ state: "FAILED" });
    const client = makeClient({ uploadResult: { state: "PROCESSING" }, get });
    const service = new GeminiService(() => client, 1);

    await expect(service.analyzeFile("/tmp/a.wav")).rejects.toThrow("processing failed");
  });

  it("throws when the response is empty", async () => {
    const client = makeClient({ generateContent: vi.fn().mockResolvedValue({ text: undefined }) });
    const service = new GeminiService(() => client, 1);

    await expect(service.analyzeFile("/tmp/a.wav")).rejects.toThrow("empty response");
  });

  it("throws without calling the SDK when GEMINI_API_KEY is missing (default factory)", async () => {
    delete process.env.GEMINI_API_KEY;
    const service = new GeminiService();

    await expect(service.analyzeFile("/tmp/a.wav")).rejects.toThrow("GEMINI_API_KEY");
  });

  it("times out when the analysis exceeds GEMINI_TIMEOUT_MS", async () => {
    process.env.GEMINI_TIMEOUT_MS = "20";
    const client = makeClient({
      generateContent: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
    });
    const service = new GeminiService(() => client, 1);

    await expect(service.analyzeFile("/tmp/a.wav")).rejects.toThrow("timed out");
  });

  it("deletes the uploaded file after analysis, even when generation fails", async () => {
    process.env.GEMINI_API_KEY = "k";
    const client = makeClient({ generateContent: vi.fn().mockRejectedValue(new Error("boom")) });
    const service = new GeminiService(() => client, 0);
    await expect(service.analyzeFile("/tmp/a.wav")).rejects.toThrow("boom");
    expect(client.files.delete).toHaveBeenCalledWith({ name: "files/abc" });
  });
});
