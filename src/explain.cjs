// Optional AI selects supplied evidence sentences. It cannot add medical facts.
async function explain(
  medicine,
  {
    key = process.env.GROQ_API_KEY,
    model = process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    fetchImpl = fetch,
    timeout = 4000,
  } = {},
) {
  const fallback = {
    kind: "catalog",
    text:
      medicine.simple ||
      medicine.description ||
      "No explanation is supplied for this record.",
    available: false,
  };
  const sentences = [
    medicine.simple,
    medicine.description,
    ...medicine.precautions,
  ].filter(Boolean);
  if (!key || !sentences.length)
    return { ...fallback, reason: "not_configured" };
  const controller = new AbortController();
  let timer;
  try {
    const task = (async () => {
      const res = await fetchImpl(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            max_tokens: 70,
            response_format: { type: "json_object" },
            messages: [
              {
                role: "system",
                content:
                  'Select up to two sentence indices for a simple explanation. Return JSON {"indices":[0]}. Use only provided evidence; choose the simplest description first. Do not write medical facts.',
              },
              {
                role: "user",
                content: JSON.stringify({ medicine: medicine.name, sentences }),
              },
            ],
          }),
        },
      );
      if (!res.ok) throw Error("Unavailable");
      return res.json();
    })();
    const data = await Promise.race([
      task,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(Error("Timeout"));
        }, timeout);
      }),
    ]);
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}");
    const indices = parsed.indices;
    if (
      !Array.isArray(indices) ||
      !indices.length ||
      indices.length > 2 ||
      indices.some(
        (i) => !Number.isInteger(i) || i < 0 || i >= sentences.length,
      )
    )
      throw Error("Invalid evidence");
    return {
      kind: "ai_selection",
      text: [...new Set(indices)].map((i) => sentences[i]).join(" "),
      available: true,
    };
  } catch {
    return { ...fallback, reason: "unavailable" };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
module.exports = { explain };
