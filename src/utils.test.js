import { describe, it, expect } from "vitest";
import {
  OUTCOME_CONFIG,
  normalizeFirstName,
  parseArgs,
  describeError,
  safeJson,
  MAX_NAME_LEN,
} from "./utils.js";

// ─── normalizeFirstName ──────────────────────────────────────────────────────
describe("normalizeFirstName", () => {
  it("returns a clean first name from a full name", () => {
    expect(normalizeFirstName("John Doe")).toBe("John");
  });

  it("strips a single honorific", () => {
    expect(normalizeFirstName("Mr Aravind")).toBe("Aravind");
  });

  it("strips a glued honorific with a period (Mr.Ara → Ara)", () => {
    expect(normalizeFirstName("Mr.Ara")).toBe("Ara");
  });

  it("strips multiple stacked honorifics", () => {
    expect(normalizeFirstName("Dr. Prof. Helena")).toBe("Helena");
  });

  it("title-cases ALL-CAPS so TTS doesn't spell it out", () => {
    expect(normalizeFirstName("NEEL")).toBe("Neel");
  });

  it("lower-cases the tail of a mixed-caps token", () => {
    expect(normalizeFirstName("aRAVIND")).toBe("Aravind");
  });

  it("prefers the first token with >= 2 letters, skipping a lone initial", () => {
    expect(normalizeFirstName("A Aravind")).toBe("Aravind");
  });

  // Edge values
  it("returns '' for empty string", () => {
    expect(normalizeFirstName("")).toBe("");
  });

  it("returns '' for whitespace-only", () => {
    expect(normalizeFirstName("   ")).toBe("");
  });

  it("returns '' for null / undefined without throwing", () => {
    expect(normalizeFirstName(null)).toBe("");
    expect(normalizeFirstName(undefined)).toBe("");
  });

  it("returns '' for digits / punctuation / emoji only", () => {
    expect(normalizeFirstName("12345")).toBe("");
    expect(normalizeFirstName("!@#$%")).toBe("");
    expect(normalizeFirstName("😀🎉")).toBe("");
  });

  it("coerces non-string input without throwing", () => {
    expect(normalizeFirstName(42)).toBe("");
    expect(normalizeFirstName({})).toBe("");
  });

  // Unicode / accents / non-Latin / RTL — must NOT be stripped to "" or mangled
  it("preserves accented Latin names", () => {
    expect(normalizeFirstName("José")).toBe("José");
    expect(normalizeFirstName("MÜLLER")).toBe("Müller");
  });

  it("preserves a CJK name unchanged", () => {
    expect(normalizeFirstName("李伟")).toBe("李伟");
  });

  it("preserves an Arabic (RTL) name unchanged", () => {
    expect(normalizeFirstName("محمد")).toBe("محمد");
  });

  it("keeps apostrophes and hyphens", () => {
    expect(normalizeFirstName("O'Brien")).toBe("O'brien");
    expect(normalizeFirstName("Anne-Marie")).toBe("Anne-marie");
  });

  it("strips an emoji glued to a real name but keeps the name", () => {
    expect(normalizeFirstName("John😀")).toBe("John");
  });

  it("caps an absurdly long name at MAX_NAME_LEN", () => {
    const long = "a".repeat(500);
    const out = normalizeFirstName(long);
    expect(out.length).toBe(MAX_NAME_LEN);
  });
});

// ─── parseArgs ───────────────────────────────────────────────────────────────
describe("parseArgs", () => {
  it("parses a JSON string", () => {
    expect(parseArgs('{"outcome":"P1_SUCCESS"}')).toEqual({ outcome: "P1_SUCCESS" });
  });

  it("returns an already-parsed object as-is", () => {
    const obj = { outcome: "P4_DECLINED" };
    expect(parseArgs(obj)).toBe(obj);
  });

  it("returns {} for invalid JSON", () => {
    expect(parseArgs("{not json")).toEqual({});
  });

  it("returns {} for null / undefined / empty string", () => {
    expect(parseArgs(null)).toEqual({});
    expect(parseArgs(undefined)).toEqual({});
    expect(parseArgs("")).toEqual({});
  });

  it("returns {} for a JSON primitive (not an object)", () => {
    expect(parseArgs("42")).toEqual({});
    expect(parseArgs('"hi"')).toEqual({});
  });

  it("returns the array when given a JSON array string (still an object)", () => {
    expect(parseArgs("[1,2]")).toEqual([1, 2]);
  });

  it("returns {} for a number passed directly", () => {
    expect(parseArgs(42)).toEqual({});
  });
});

// ─── describeError / safeJson ────────────────────────────────────────────────
describe("describeError", () => {
  it("returns 'Unknown error' for null/undefined", () => {
    expect(describeError(null)).toBe("Unknown error");
    expect(describeError(undefined)).toBe("Unknown error");
  });

  it("returns a string error verbatim", () => {
    expect(describeError("boom")).toBe("boom");
  });

  it("reads a nested error.message", () => {
    expect(describeError({ error: { message: "bad mic" } })).toBe("bad mic");
  });

  it("reads a Daily-style errorMsg", () => {
    expect(describeError({ errorMsg: "meeting has ended" })).toBe("meeting has ended");
  });

  it("reads a plain Error's message", () => {
    expect(describeError(new Error("kaput"))).toBe("kaput");
  });

  it("falls back to type when no message", () => {
    expect(describeError({ type: "no-room" })).toBe("no-room");
  });

  it("does not throw on a circular object", () => {
    const a = {};
    a.self = a;
    expect(() => describeError(a)).not.toThrow();
    expect(typeof describeError(a)).toBe("string");
  });
});

describe("safeJson", () => {
  it("stringifies a normal object", () => {
    expect(safeJson({ a: 1 })).toBe('{"a":1}');
  });
  it("does not throw on a circular reference", () => {
    const a = {};
    a.self = a;
    expect(() => safeJson(a)).not.toThrow();
  });
});

// ─── OUTCOME_CONFIG completeness ─────────────────────────────────────────────
describe("OUTCOME_CONFIG", () => {
  const CODES = ["P1_SUCCESS", "P2_VOICEMAIL", "P3_UNREACHABLE", "P4_DECLINED", "P5_WRONG_PERSON", "P6_UNCLEAR"];

  it("has an entry for all six set_outcome enum codes", () => {
    for (const code of CODES) expect(OUTCOME_CONFIG[code]).toBeDefined();
  });

  it("every entry has the fields the UI renders", () => {
    for (const code of CODES) {
      const cfg = OUTCOME_CONFIG[code];
      expect(cfg).toMatchObject({
        label: expect.any(String),
        cls: expect.any(String),
        icon: expect.any(String),
        cardState: expect.any(String),
        title: expect.any(String),
        msg: expect.any(String),
      });
    }
  });
});
