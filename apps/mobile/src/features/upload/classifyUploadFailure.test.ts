import { ApiError, UploadRecordingError } from "@bandapp/api-client";
import { describe, expect, it } from "vitest";
import { classifyUploadFailure } from "./classifyUploadFailure";
import { MissingUploadFileError } from "./uploadErrors";

describe("classifyUploadFailure", () => {
  it("missing file or record: discard, not retryable", () => {
    expect(classifyUploadFailure(new MissingUploadFileError(), "resume")).toEqual({
      message: "Recording file is missing", discard: true, retryable: false, refetch: false,
    });
    expect(classifyUploadFailure(new MissingUploadFileError(), "upload")).toEqual({
      message: "Recording file is missing", discard: true, retryable: false, refetch: false,
    });
  });

  it("404: discard, not retryable", () => {
    expect(classifyUploadFailure(new ApiError(404, "not found"), "resume")).toEqual({
      message: "This session no longer exists", discard: true, retryable: false, refetch: false,
    });
  });

  it("409 (already completed elsewhere): discard and refetch the session", () => {
    expect(classifyUploadFailure(new ApiError(409, "done"), "resume")).toEqual({
      message: "", discard: true, retryable: false, refetch: true,
    });
  });

  it("anything else keeps the record and is retryable, with a mode-specific message", () => {
    expect(classifyUploadFailure(new TypeError("Network request failed"), "resume")).toEqual({
      message: "Couldn’t resume the upload — check your connection and try again", discard: false, retryable: true, refetch: false,
    });
    expect(classifyUploadFailure(new Error("part 3 upload failed with HTTP 500"), "upload")).toEqual({
      message: "Couldn’t upload this recording — check your connection and try again", discard: false, retryable: true, refetch: false,
    });
    expect(classifyUploadFailure("weird", "upload").retryable).toBe(true);
  });

  it("upload mode 404 (from sessions.create) is not treated as a missing session — generic upload failure", () => {
    expect(classifyUploadFailure(new ApiError(404, "not found"), "upload")).toEqual({
      message: "Couldn’t upload this recording — check your connection and try again", discard: false, retryable: true, refetch: false,
    });
  });

  it("resume mode 500 is retryable with the resume message", () => {
    expect(classifyUploadFailure(new ApiError(500, "boom"), "resume")).toEqual({
      message: "Couldn’t resume the upload — check your connection and try again", discard: false, retryable: true, refetch: false,
    });
  });

  it("unwraps UploadRecordingError to classify its cause — missing file wrapped from a first-attempt failure", () => {
    const wrapped = new UploadRecordingError("upload failed", "s1", new MissingUploadFileError());
    expect(classifyUploadFailure(wrapped, "upload")).toEqual({
      message: "Recording file is missing", discard: true, retryable: false, refetch: false,
    });
  });
});
