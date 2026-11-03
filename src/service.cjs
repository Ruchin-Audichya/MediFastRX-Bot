const boundary =
  "I can explain the catalog, but cannot decide whether a medicine is right for you, recommend a dose, or suggest a substitute. A pharmacist or clinician can check your situation.";
const empty = () => ({ medicineId: null, intent: null });
function createMedicineService(catalog) {
  function respond({ query = "", state = {}, confirmId = null } = {}) {
    const text = String(query)
      .trim()
      .replace(/[’‘]/g, "'")
      .replace(/^मुझे\s*/, "")
      .replace(/\s*चाहिए[.!?]?$/, "")
      .replace(/डोलो/g, "Dolo")
      .replace(/सेटिरिजिन/g, "Cetirizine")
      .replace(/पैरासिटामोल/g, "Paracetamol")
      .replace(/मिलीग्राम/g, "mg")
      .replace(/^mujhe\s+/i, "")
      .replace(/\s+(?:chahiye|chahie|chaiye)[.!?]?$/i, "")
      .replace(
        /^(?:please\s+)?(?:can you|could you)\s+(?:tell me about|explain|identify)\s+/i,
        "what is ",
      )
      .replace(/^please\s+(?:tell me about|explain)\s+/i, "what is ")
      .replace(
        /^where (?:can|could) i (?:find|get|buy)\s+(.+?)[?.!]?$/i,
        "find pharmacies $1",
      )
      .replace(
        /^(?!(?:what|tell|show|any|iske|is ke)\b)(.+?)\s+(?:ke |ki )?side effects[?.!]?$/i,
        "side effects of $1",
      )
      .replace(
        /^(?:iska|iske|is ka)\s+(?:generic|salt|ingredient)[?.!]?$/i,
        "generic",
      )
      .replace(/^(?:iske|is ke)\s+side effects[?.!]?$/i, "side effects")
      .replace(/^(.+?)\s+kya hai[?.!]?$/i, "what is $1")
      .replace(
        /^(?:yeh|ye|isko|ise)\s+(?:samjhao|samjha do)[?.!]?$/i,
        "explain simply",
      )
      .replace(
        /^(?:mere aas paas kaha milegi|mere aas paas|sabse paas wali shop|near me)[?.!]?$/i,
        "find pharmacies",
      );
    const current = catalog.get(
      typeof state?.medicineId === "string" ? state.medicineId : "",
    );
    const context = { medicineId: current?.id || null, intent: null };
    const result = (status, extra = {}) => ({
      status,
      medicine: null,
      candidates: [],
      answer: null,
      state: context,
      ...extra,
    });
    if (/^(reset|clear|start over)$/i.test(text))
      return result("reset", {
        state: empty(),
        answer: "A fresh start. Which medicine is on your mind?",
      });
    const personal =
      /\b(can|should|could|may) (i|we|my)|\b(dose|dosage|pregnant|pregnancy|breastfeed|safe for|is it safe|suitable|substitute|instead of|stop taking|start taking|how (much|many|often)|recommend|diagnos|my symptoms|medicine for|tablet for|bukhar ki|le sakta|le sakti|kitni baar)\b/i.test(
        text,
      );
    if (personal)
      return result("boundary", {
        medicine: current,
        answer: boundary,
        state: { ...context, intent: "suitability" },
      });
    let intent = null,
      explicit = text;
    const patterns = [
      [
        "side_effects",
        /^(?:(?:what are|tell me|show me|any)\s+)?(?:the\s+)?side effects(?:\s+(?:of|for))?\s*(.*?)\??$/i,
      ],
      [
        "generic",
        /^(?:what(?:'s| is)\s+)?(?:the\s+)?(?:generic|active ingredients?)(?:\s+(?:of|for))?\s*(.*?)\??$/i,
      ],
      [
        "simple",
        /^(?:explain simply|explain|what is|what about|tell me about)\s*(.*?)\??$/i,
      ],
      [
        "pharmacies",
        /^(?:find\s+)?(?:nearby\s+)?pharmac(?:y|ies)(?:\s+(?:for|near))?\s*(.*?)\??$/i,
      ],
    ];
    for (const [name, re] of patterns) {
      const match = text.match(re);
      if (match) {
        intent = name;
        explicit = match[1].trim().replace(/\?$/, "");
        if (/^(it|this|that|this medicine|me|simply)$/i.test(explicit))
          explicit = "";
        break;
      }
    }
    if (
      /^(?:explain simply|what does (?:it|this) do|what is (?:it|this) used for|tell me more)[.!?]?$/i.test(
        text,
      )
    ) {
      intent = "simple";
      explicit = "";
    }
    let med = null,
      method = null;
    if (confirmId) {
      med = catalog.get(confirmId);
      intent = [
        "details",
        "simple",
        "generic",
        "side_effects",
        "pharmacies",
      ].includes(state?.intent)
        ? state.intent
        : "details";
      if (!med)
        return result("not_found", {
          answer:
            "That record is no longer in this catalog. Please search again.",
          state: empty(),
        });
      method = "confirmed";
    } else if (intent && !explicit) {
      med = current;
      if (!med)
        return result("needs_medicine", {
          answer: "Search for a medicine first, so I know which one you mean.",
          state: empty(),
        });
    } else {
      const match = catalog.resolve(explicit);
      if (match.status !== "confirmed")
        return result(match.status, {
          candidates: match.candidates,
          method: match.method,
          state: { medicineId: null, intent: intent || "details" },
          answer:
            match.status === "candidates"
              ? "Found a possible match. Check the name, strength and form against your package."
              : "No match in this catalog. Try the name on the pack, including its strength. I won’t guess medical facts.",
        });
      med = match.candidates[0];
      method = match.method;
    }
    intent = intent || "details";
    let answer =
      med.description ||
      "A description is not supplied for this record. Check the linked source or ask a pharmacist.";
    if (intent === "generic")
      answer = `Active ingredient${med.generic.includes("+") ? "s" : ""}: ${med.generic}. Shared ingredients do not make different strengths, forms or combinations interchangeable.`;
    if (intent === "side_effects")
      answer = med.sideEffects.length
        ? `The source lists: ${med.sideEffects.map((x) => x.replace(/[.!]+$/, "")).join("; ")}. This is a short summary, not a complete list.`
        : "Side effects are not supplied for this record. Check the leaflet or ask a pharmacist.";
    if (intent === "simple")
      answer =
        med.simple ||
        med.description ||
        "A plain-language explanation is not supplied for this record.";
    if (intent === "pharmacies")
      answer =
        "Let’s find places to contact. Call to confirm stock before you head out.";
    return result("confirmed", {
      medicine: med,
      method,
      answer,
      state: { medicineId: med.id, intent },
    });
  }
  return { respond };
}
module.exports = { createMedicineService, boundary };
