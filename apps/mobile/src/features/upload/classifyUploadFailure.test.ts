import { ApiError } from "@bandapp/api-client";
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
});
