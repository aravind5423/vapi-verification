import { describe, it, expect } from "vitest";
import { resolve, extractFacts, crossCheck, surveyResponse } from "../api/resolve.js";
import { isDisplayable, NEEDS_REVIEW } from "../src/outcomes.js";

// The resolver is fully deterministic and offline — no LLM, no network. These tests
// pin every failure bucket from the Phase-1 evidence catalogue (the 30 real calls),
// plus garbled/ambiguous/abstention cases and the future explicit-fact-tool path.

const T = (...lines) => lines.join("\n");
const SURVEY = "AI: On the new tariff policies, are you feeling happy, neutral, upset, or no comment?";
const r = (transcript, endedReason = "assistant-said-end-call-phrase", facts = {}) =>
  resolve({ transcript, endedReason, facts });

describe("resolve — confirmed + survey answer → P1", () => {
  it("clean sentiment answer", () => {
    expect(r(T("AI: is this Sam?", "User: Yes.", SURVEY, "User: I feel happy.")).code).toBe("P1_SUCCESS");
  });
  it("'no comment' counts as an answer", () => {
    expect(r(T("AI: is this Sam?", "User: yeah", SURVEY, "User: no comment.")).code).toBe("P1_SUCCESS");
  });
  it("garbled NAME doesn't break a clean confirm+answer", () => {
    expect(r(T("AI: is this Erovent?", "User: Yes, speaking.", SURVEY, "User: upset honestly.")).code).toBe("P1_SUCCESS");
  });
});

describe("resolve — confirmed but no real survey answer → P8", () => {
  it("confirmed then 'I'm busy' (B2 — the false-P1 family)", () => {
    expect(r(T("AI: is this Sam?", "User: yeah yeah", SURVEY, "User: I'm busy now.")).code).toBe("P8_VERIFIED_NO_SURVEY");
  });
  it("confirmed then explicitly refuses the survey (B7, call 27)", () => {
    expect(r(T("AI: is this Sam?", "User: yes you are", SURVEY, "User: I don't wanna answer.")).code).toBe("P8_VERIFIED_NO_SURVEY");
  });
  it("confirmed, call ends before any survey response", () => {
    expect(r(T("AI: is this Sam?", "User: yes that's me.")).code).toBe("P8_VERIFIED_NO_SURVEY");
  });
});

describe("resolve — ABSTENTION to NEEDS_REVIEW (B4: over-confidence killers)", () => {
  const ambiguous = [
    ["'make up something' (call 4)", "I'm gonna make up something, can you be quick?"],
    ["'not really sure' (call 22)", "Not really sure."],
    ["'not really sir' (call 21)", "Not really, sir."],
    ["garbled 'Local.' (call 26)", "Local."],
    ["'why should it matter' (call 1)", "I'm living in India, why should it even matter to me?"],
  ];
  for (const [name, resp] of ambiguous) {
    it(`confirmed but survey response is ambiguous → review: ${name}`, () => {
      const out = r(T("AI: is this Sam?", "User: yes", SURVEY, `User: ${resp}`));
      expect(out.code).toBe(NEEDS_REVIEW);
      expect(out.source).toBe("abstain");
    });
  }
  it("contradictory confirm+deny ('Yeah. No.') is never a confident verified code", () => {
    const out = r(T("AI: is this Sam?", "User: Yeah. No."));
    expect(["P5_WRONG_PERSON", NEEDS_REVIEW]).toContain(out.code);
    expect(out.code).not.toBe("P1_SUCCESS");
    expect(out.code).not.toBe("P8_VERIFIED_NO_SURVEY");
  });
});

describe("resolve — a 'no' in the SURVEY answer is not an identity denial (call 019e7886 bug)", () => {
  it("confirmed, then 'No, I'm happy' → P1 (not a false NEEDS_REVIEW)", () => {
    expect(r(T("AI: is this Sam?", "User: Yes.", SURVEY, "User: No, I'm happy actually.")).code).toBe("P1_SUCCESS");
  });
  it("confirmed, then 'No, I'm pretty upset about it' → P1", () => {
    expect(r(T("AI: is this Sam?", "User: yeah", SURVEY, "User: No, I'm pretty upset about it.")).code).toBe("P1_SUCCESS");
  });
  it("confirmed, then a GARBLED 'No. US able. Than India.' → NEEDS_REVIEW for the RIGHT reason", () => {
    const out = r(T("AI: is this Sam?", "User: Yes.", SURVEY, "User: No. US able. Than India."));
    expect(out.code).toBe(NEEDS_REVIEW);
    expect(out.reason).toMatch(/ambiguous/i);          // ambiguous survey response, NOT "contradictory identity"
    expect(out.reason).not.toMatch(/contradictory/i);
  });
  it("identity-phase 'Yeah. No.' still resolves to wrong person (no regression)", () => {
    expect(r(T("AI: is this Sam?", "User: Yeah. No.")).code).toBe("P5_WRONG_PERSON");
  });
});

describe("resolve — never confirmed", () => {
  it("evasive + busy, never a yes/no → P6 (B1, call 3/14)", () => {
    expect(r(T("AI: is this Sam?", "User: who is this?", "AI: a survey — is this Sam?", "User: how'd you get my number?", "User: I'm busy")).code).toBe("P6_UNCLEAR");
  });
  it("scam suspicion with NO decline token → P6, not P4 (B6, call 23/24)", () => {
    expect(r(T("AI: is this Sam?", "User: it feels like a scam call.")).code).toBe("P6_UNCLEAR");
  });
  it("'who is this speaking?' is NOT a confirmation (the 'speaking' false-positive)", () => {
    expect(r(T("AI: is this Sam?", "User: who is this speaking?", "User: it feels like a scam.")).code).toBe("P6_UNCLEAR");
  });
  it("explicit decline before confirming → P4 (call 16)", () => {
    expect(r(T("AI: is this Sam?", "User: not interested.")).code).toBe("P4_DECLINED");
  });
  it("DNC / 'take me off' → P4", () => {
    expect(r(T("AI: is this Sam?", "User: take me off your list.")).code).toBe("P4_DECLINED");
  });
  it("legal threat → P4", () => {
    expect(r(T("AI: is this Sam?", "User: I'll sue you, stop calling, this is harassment.")).code).toBe("P4_DECLINED");
  });
  it("explicit 'No' → P5 (call 8/20/29/30)", () => {
    expect(r(T("AI: is this Sam?", "User: No.")).code).toBe("P5_WRONG_PERSON");
  });
  it("different name / wrong number → P5", () => {
    expect(r(T("AI: is this David?", "User: No, this is his wife, he's not here.")).code).toBe("P5_WRONG_PERSON");
  });
  it("hung up before confirming → P7 (call 7)", () => {
    expect(r(T("AI: is this Sam?", "User: who's this?"), "customer-ended-call").code).toBe("P7_HUNGUP_EARLY");
  });
});

describe("resolve — deterministic terminals", () => {
  it("voicemail by transcript marker → P2", () => {
    expect(r(T("AI: hi", "User: leave a message after the tone")).code).toBe("P2_VOICEMAIL");
  });
  it("voicemail by endedReason → P2", () => {
    expect(r(T("AI: hi"), "voicemail").code).toBe("P2_VOICEMAIL");
  });
  it("no caller audio / silence → P3 (call 2/15)", () => {
    expect(r("", "call.in-progress.error-assistant-did-not-receive-customer-audio").code).toBe("P3_UNREACHABLE");
    expect(r("", "silence-timed-out").code).toBe("P3_UNREACHABLE");
  });
});

describe("resolve — explicit fact tools win over derived", () => {
  const convo = T("AI: is this Sam?", "User: hello there");
  it("confirm_identity + record_survey(sentiment) → P1", () => {
    expect(r(convo, "assistant-said-end-call-phrase", { identity: "confirmed", survey: { answered: true, sentiment: "happy" } }).code).toBe("P1_SUCCESS");
  });
  it("confirm_identity + survey_declined → P8", () => {
    expect(r(convo, "assistant-said-end-call-phrase", { identity: "confirmed", surveyDeclined: true }).code).toBe("P8_VERIFIED_NO_SURVEY");
  });
  it("wrong_person fact → P5", () => {
    expect(r(convo, "assistant-said-end-call-phrase", { identity: "denied", wrongPerson: true }).code).toBe("P5_WRONG_PERSON");
  });
  it("decline_call fact (no confirm) → P4", () => {
    expect(r("AI: hi\nUser: hello", "assistant-said-end-call-phrase", { declined: true }).code).toBe("P4_DECLINED");
  });
  it("mark_voicemail fact → P2", () => {
    expect(r("AI: hi", "assistant-said-end-call-phrase", { voicemail: true }).code).toBe("P2_VOICEMAIL");
  });
  it("a fact claiming the call progressed but NO caller audio → review (contradiction)", () => {
    expect(r("", "silence-timed-out", { identity: "confirmed" }).code).toBe(NEEDS_REVIEW);
  });
});

describe("extractFacts — parses the future fact tool calls", () => {
  it("reads confirm_identity / record_survey from tool calls", () => {
    const messages = [
      { toolCalls: [{ function: { name: "confirm_identity", arguments: "{}" } }] },
      { toolCalls: [{ function: { name: "record_survey", arguments: '{"sentiment":"upset"}' } }] },
    ];
    expect(extractFacts(messages)).toEqual({ identity: "confirmed", survey: { answered: true, sentiment: "upset" } });
  });
  it("returns {} for calls with no fact tools (today's reality)", () => {
    expect(extractFacts([{ toolCalls: [{ function: { name: "set_outcome", arguments: '{"outcome":"P1_SUCCESS"}' } }] }])).toEqual({});
  });
});

describe("crossCheck — only raises review on a FACT-based contradiction", () => {
  it("fact-based P1 contradicted by P5 → review", () => {
    expect(crossCheck({ code: "P1_SUCCESS", source: "fact" }, "P5_WRONG_PERSON").code).toBe(NEEDS_REVIEW);
  });
  it("DERIVED P1 contradicted by P5 → unchanged (LLM reads the same transcript)", () => {
    expect(crossCheck({ code: "P1_SUCCESS", source: "derived" }, "P5_WRONG_PERSON").code).toBe("P1_SUCCESS");
  });
  it("fact-based P1 agreeing with P8 (both verified) → unchanged", () => {
    expect(crossCheck({ code: "P1_SUCCESS", source: "fact" }, "P8_VERIFIED_NO_SURVEY").code).toBe("P1_SUCCESS");
  });
});

describe("resolve — invariants", () => {
  it("always returns a displayable code", () => {
    const cases = [
      r(T("AI: is this Sam?", "User: yes", SURVEY, "User: happy")),
      r(T("AI: is this Sam?", "User: blah blah")),
      r("", "silence-timed-out"),
      r(T("AI: is this Sam?", "User: Local."), "assistant-said-end-call-phrase"),
    ];
    for (const c of cases) expect(isDisplayable(c.code)).toBe(true);
  });
});

describe("surveyResponse helper", () => {
  it("returns the user turn after the survey question", () => {
    expect(surveyResponse(T("AI: is this Sam?", "User: yes", SURVEY, "User: I'm upset."))).toBe("i'm upset.");
  });
  it("returns null when the survey was never asked", () => {
    expect(surveyResponse(T("AI: is this Sam?", "User: who is this?"))).toBeNull();
  });
});
