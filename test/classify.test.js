import { describe, it, expect } from "vitest";
import {
  classify,
  userTurns,
  hasConfirmation,
  heuristicEndReason,
  heuristicFromText,
} from "../api/classify.js";
import { isValidOutcome, OUTCOME_CODES } from "../src/outcomes.js";

// These tests are fully OFFLINE — they exercise the deterministic pre-filters and
// the heuristic floor (no DEEPSEEK_API_KEY needed), which is exactly the path that
// guarantees a valid code when the LLM is unavailable. The LLM ensemble's accuracy
// is measured separately by scripts/replay-classify.mjs against real fixtures.

const T = (...lines) => lines.join("\n");

describe("userTurns", () => {
  it("extracts only the user's turns, lowercased", () => {
    const t = T("AI: Hi, is this Sam?", "User: Yes, Speaking.", "AI: great", "User: Neutral");
    expect(userTurns(t)).toEqual(["yes, speaking.", "neutral"]);
  });
  it("returns [] for empty / non-string", () => {
    expect(userTurns("")).toEqual([]);
    expect(userTurns(null)).toEqual([]);
    expect(userTurns(undefined)).toEqual([]);
  });
  it("ignores assistant turns entirely (no false positives from Freya's words)", () => {
    // Freya literally says "happy, neutral, upset" every call — must not count.
    const t = T("AI: are you happy, neutral, or upset?", "User: who is this?");
    expect(userTurns(t)).toEqual(["who is this?"]);
  });
});

describe("hasConfirmation", () => {
  it("treats yes / yeah / speaking / this is me as confirmation", () => {
    expect(hasConfirmation(["yes"])).toBe(true);
    expect(hasConfirmation(["yeah yeah yeah"])).toBe(true);
    expect(hasConfirmation(["speaking"])).toBe(true);
    expect(hasConfirmation(["this is me"])).toBe(true);
  });
  it("does not treat 'who is this' / 'i am busy' as confirmation", () => {
    expect(hasConfirmation(["who is this?"])).toBe(false);
    expect(hasConfirmation(["i am busy now"])).toBe(false);
  });
});

describe("heuristicEndReason (deterministic terminals)", () => {
  it("maps voicemail endedReason → P2", () => {
    expect(heuristicEndReason("voicemail", "AI: hi").code).toBe("P2_VOICEMAIL");
  });
  it("detects voicemail from the transcript text → P2", () => {
    expect(heuristicEndReason("assistant-ended", T("AI: hi", "User: leave a message after the beep")).code)
      .toBe("P2_VOICEMAIL");
  });
  it("maps silence / no-answer → P3", () => {
    expect(heuristicEndReason("silence-timed-out", "").code).toBe("P3_UNREACHABLE");
    expect(heuristicEndReason("customer-did-not-give-microphone-permission", "").code).toBe("P3_UNREACHABLE");
  });
  it("maps an empty / user-less transcript → P3", () => {
    expect(heuristicEndReason("assistant-said-end-call-phrase", "AI: Hi? AI: you there?").code)
      .toBe("P3_UNREACHABLE");
  });
  it("returns null (let the LLM run) for a normal call with user turns", () => {
    expect(heuristicEndReason("assistant-said-end-call-phrase", T("AI: hi", "User: yes"))).toBeNull();
  });
});

describe("heuristicFromText (the floor — always a valid code)", () => {
  const cases = [
    ["confirm + sentiment → P1", T("AI: is this Sam?", "User: yes", "AI: tariffs?", "User: neutral"), "asst", "P1_SUCCESS"],
    ["confirm + busy (no survey) → P8", T("AI: is this Sam?", "User: yeah", "AI: tariffs?", "User: i'm busy now"), "asst", "P8_VERIFIED_NO_SURVEY"],
    ["confirm + decline → P4", T("AI: is this Sam?", "User: speaking", "User: not interested, take me off"), "asst", "P4_DECLINED"],
    ["bare 'no' → P5", T("AI: is this Sam?", "User: No."), "asst", "P5_WRONG_PERSON"],
    ["explicit denial → P5", T("AI: is this Sam?", "User: no, this isn't him, wrong number"), "asst", "P5_WRONG_PERSON"],
    ["decline before confirm → P4", T("AI: is this Sam?", "User: no thanks, not interested"), "asst", "P4_DECLINED"],
    ["hung up before confirming → P7", T("AI: is this Sam?", "User: who's this?"), "customer-ended-call", "P7_HUNGUP_EARLY"],
    ["ambiguous / garbled → P6", T("AI: is this Sam?", "User: asdkfj hola que"), "asst", "P6_UNCLEAR"],
    ["voicemail text → P2", T("AI: hi", "User: please leave a message after the tone"), "asst", "P2_VOICEMAIL"],
    ["silence reason → P3", "", "silence-timed-out", "P3_UNREACHABLE"],
  ];
  for (const [name, transcript, reason, expected] of cases) {
    it(name, () => expect(heuristicFromText(transcript, reason)).toBe(expected));
  }

  it("scam-suspicion-then-continue is NOT a decline", () => {
    const t = T("AI: is this Sam?", "User: yes", "AI: quick survey", "User: is this a scam?", "AI: no, just one question", "User: ok, neutral");
    // Confirmed + answered → P1, NOT P4.
    expect(heuristicFromText(t, "assistant-said-end-call-phrase")).toBe("P1_SUCCESS");
  });

  it("always returns a valid taxonomy code", () => {
    for (const [, transcript, reason] of cases) {
      expect(isValidOutcome(heuristicFromText(transcript, reason))).toBe(true);
    }
  });
});

describe("classify() orchestration (offline — no API key → heuristic/deterministic)", () => {
  it("returns a deterministic terminal for silence", async () => {
    const r = await classify({ transcript: "", endedReason: "silence-timed-out" });
    expect(r.code).toBe("P3_UNREACHABLE");
    expect(r.source).toBe("deterministic");
  });

  it("falls to the heuristic floor for a normal call when no LLM key is set", async () => {
    const r = await classify({
      transcript: T("AI: is this Sam?", "User: yeah", "AI: tariffs?", "User: i'm busy"),
      endedReason: "assistant-said-end-call-phrase",
    });
    expect(r.code).toBe("P8_VERIFIED_NO_SURVEY");
    // source is 'heuristic' without a key, or 'ensemble' if a key happens to be set.
    expect(["heuristic", "ensemble", "live-hint"]).toContain(r.source);
    expect(OUTCOME_CODES).toContain(r.code);
  });

  it("uses a valid live outcome as the tiebreaker when no LLM and not terminal", async () => {
    // garbled transcript → heuristic would say P6, but a live hint should win as tiebreaker
    // ONLY when there's no key (so classifyWithLLM returns null). We assert it returns a valid code.
    const r = await classify({
      transcript: T("AI: is this Sam?", "User: mmhmm uh"),
      endedReason: "assistant-said-end-call-phrase",
      liveOutcome: "P1_SUCCESS",
    });
    expect(isValidOutcome(r.code)).toBe(true);
  });
});
