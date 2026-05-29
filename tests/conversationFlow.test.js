const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildSearchActionKeyboard,
  formatSearchFollowUp,
  formatSearchResults,
} = require("../src/utils/formatter");

test("search response is short, structured, and exposes action buttons", () => {
  const message = formatSearchResults(
    [
      {
        medicineName: "Dolo 650",
        genericName: "Paracetamol",
        category: "painkiller",
        knowledgeOnly: true,
        confidence: 0.91,
        pharmacy: {
          name: "Knowledge Catalog",
          area: "No live stock",
          address: "Known medicine, call pharmacy to confirm",
        },
      },
    ],
    "Dolo 650",
    { intent: { label: "fever support", confidence: "high" } }
  );
  const keyboard = buildSearchActionKeyboard("Dolo 650");

  assert.match(message, /Dolo 650/);
  assert.match(message, /Used for/i);
  assert.match(message, /Availability/i);
  assert.match(message, /blockquote expandable/);
  assert.equal(keyboard.inline_keyboard[0][0].text, "📍 Nearby");
  assert.equal(keyboard.inline_keyboard[0][1].text, "⚠️ Side Effects");
  assert.equal(keyboard.inline_keyboard[1][0].text, "🔁 Alternatives");
  assert.equal(keyboard.inline_keyboard[1][1].text, "💾 Save");
});

test("low confidence conversation asks a clarifying question", () => {
  const message = formatSearchFollowUp("tablet chahiye");

  assert.match(message, /I need one more detail/);
  assert.match(message, /Dolo 650/);
  assert.match(message, /bukhar ki tablet/);
});
