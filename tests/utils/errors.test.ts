import { describe, it, expect } from "vitest";
import {
  MarkLogicError,
  AuthenticationError,
  NotFoundError,
  WriteProtectedError,
  EvalDisabledError,
  ForbiddenError,
  appendRangeIndexHint,
  toToolError,
} from "../../src/utils/errors.js";

describe("MarkLogicError", () => {
  it("sets name to MarkLogicError", () => {
    const err = new MarkLogicError("something went wrong");
    expect(err.name).toBe("MarkLogicError");
    expect(err.message).toBe("something went wrong");
    expect(err instanceof Error).toBe(true);
  });

  it("stores optional statusCode and mlCode", () => {
    const err = new MarkLogicError("bad value", 400, "ML-XDMP-BADVAL");
    expect(err.statusCode).toBe(400);
    expect(err.mlCode).toBe("ML-XDMP-BADVAL");
  });

  it("accepts undefined statusCode and mlCode", () => {
    const err = new MarkLogicError("generic");
    expect(err.statusCode).toBeUndefined();
    expect(err.mlCode).toBeUndefined();
  });
});

describe("AuthenticationError", () => {
  it("sets name, message with host, and statusCode 401", () => {
    const err = new AuthenticationError("localhost:8000");
    expect(err.name).toBe("AuthenticationError");
    expect(err.message).toContain("localhost:8000");
    expect(err.statusCode).toBe(401);
    expect(err instanceof MarkLogicError).toBe(true);
  });
});

describe("NotFoundError", () => {
  it("includes URI in message and sets statusCode 404", () => {
    const err = new NotFoundError("/data/customers/cust-001.json");
    expect(err.name).toBe("NotFoundError");
    expect(err.message).toContain("/data/customers/cust-001.json");
    expect(err.statusCode).toBe(404);
    expect(err instanceof MarkLogicError).toBe(true);
  });
});

describe("WriteProtectedError", () => {
  it("sets name and references ML_READONLY in message", () => {
    const err = new WriteProtectedError();
    expect(err.name).toBe("WriteProtectedError");
    expect(err.message).toContain("ML_READONLY");
    expect(err instanceof Error).toBe(true);
  });
});

describe("EvalDisabledError", () => {
  it("sets name and references ML_ALLOW_EVAL in message", () => {
    const err = new EvalDisabledError();
    expect(err.name).toBe("EvalDisabledError");
    expect(err.message).toContain("ML_ALLOW_EVAL");
    expect(err instanceof Error).toBe(true);
  });
});

describe("ForbiddenError", () => {
  it("sets name, statusCode 403, and message", () => {
    const err = new ForbiddenError("operation not permitted");
    expect(err.name).toBe("ForbiddenError");
    expect(err.statusCode).toBe(403);
    expect(err.message).toBe("operation not permitted");
    expect(err instanceof MarkLogicError).toBe(true);
  });
});

describe("toToolError", () => {
  it("returns raw message for WriteProtectedError (no HTTP prefix)", () => {
    const result = toToolError(new WriteProtectedError());
    expect(result).toContain("ML_READONLY");
    expect(result).not.toContain("MarkLogic error");
  });

  it("returns raw message for EvalDisabledError (no HTTP prefix)", () => {
    const result = toToolError(new EvalDisabledError());
    expect(result).toContain("ML_ALLOW_EVAL");
    expect(result).not.toContain("MarkLogic error");
  });

  it("formats MarkLogicError with HTTP status and mlCode", () => {
    const result = toToolError(new MarkLogicError("bad value", 400, "ML-XDMP-BADVAL"));
    expect(result).toContain("HTTP 400");
    expect(result).toContain("ML-XDMP-BADVAL");
    expect(result).toContain("bad value");
  });

  it("formats MarkLogicError with status but no mlCode", () => {
    const result = toToolError(new MarkLogicError("server error", 500));
    expect(result).toContain("HTTP 500");
    expect(result).toContain("server error");
    expect(result).not.toContain("[");
  });

  it("formats MarkLogicError without status or mlCode", () => {
    const result = toToolError(new MarkLogicError("generic error"));
    expect(result).toContain("generic error");
    expect(result).not.toContain("HTTP");
    expect(result).not.toContain("[");
  });

  it("formats AuthenticationError as a MarkLogicError subclass", () => {
    const result = toToolError(new AuthenticationError("myhost"));
    expect(result).toContain("HTTP 401");
    expect(result).toContain("myhost");
  });

  it("formats ForbiddenError as a MarkLogicError subclass", () => {
    const result = toToolError(new ForbiddenError("access denied"));
    expect(result).toContain("HTTP 403");
    expect(result).toContain("access denied");
  });

  it("returns plain message for a standard Error", () => {
    expect(toToolError(new Error("plain error"))).toBe("plain error");
  });

  it("converts a non-Error value to string", () => {
    expect(toToolError("just a string")).toBe("just a string");
    expect(toToolError(42)).toBe("42");
    expect(toToolError(null)).toBe("null");
  });
});

describe("appendRangeIndexHint", () => {
  it.each([
    "XDMP-PATHRIDXNOTFOUND: No path range index for properties/cost_per_kg_usd",
    "XDMP-ELEMRIDXNOTFOUND: No element range index for age",
    "XDMP-FIELDRIDXNOTFOUND: No field range index",
    "XDMP-ELEMATTRRIDXNOTFOUND: No attribute range index",
    "XDMP-GEOIDXNOTFOUND: No geospatial index",
  ])("appends the hint for %s", (msg) => {
    const result = appendRangeIndexHint(msg);
    expect(result).toContain(msg);
    expect(result).toContain("Hint:");
    expect(result).toContain("ml_indexes_list");
    expect(result).toContain("ml_reindex_status");
  });

  it("mentions the exact-match and index-kind traps", () => {
    const result = appendRangeIndexHint("XDMP-PATHRIDXNOTFOUND: nope");
    expect(result).toContain("character-for-character");
    expect(result).toContain("cts.pathReference");
    expect(result).toContain("cts.jsonPropertyRangeQuery");
  });

  it("leaves unrelated errors untouched", () => {
    expect(appendRangeIndexHint("XDMP-ARGTYPE: wrong type")).toBe("XDMP-ARGTYPE: wrong type");
    expect(appendRangeIndexHint("SQL-TABLENOTFOUND")).toBe("SQL-TABLENOTFOUND");
    expect(appendRangeIndexHint("plain error")).toBe("plain error");
  });
});
