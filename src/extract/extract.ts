import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

export type Extractor = (image: Buffer, mime: string) => Promise<string>;

/**
 * Prescription → candidate medicine lines. The output is only ever *text*: every line still
 * goes through the deterministic catalog resolver and an explicit tap by the customer.
 *
 * - Local (default): Tesseract with bundled English data. Good on printed text, weak on handwriting.
 * - Claude vision (when ANTHROPIC_API_KEY is set): reads handwriting far better. It is asked
 *   to transcribe medicine lines only, never to interpret, correct or suggest.
 */
export function createExtractor(opts: { anthropicKey?: string; model?: string } = {}): Extractor {
  return opts.anthropicKey ? claudeExtractor(opts.anthropicKey, opts.model ?? "claude-opus-5-5", localExtractor()) : localExtractor();
}

function localExtractor(): Extractor {
  let worker: Promise<any> | null = null;
  let queue = Promise.resolve<unknown>(null);
  const langPath = join(dirname(createRequire(import.meta.url).resolve("@tesseract.js-data/eng/package.json")), "4.0.0_best_int");
  return (image) => {
    const job = queue.then(async () => {
      worker ??= import("tesseract.js").then((t) => t.createWorker("eng", 1, { langPath, cacheMethod: "none", gzip: true }));
      const w = await worker;
      const { data } = await Promise.race([
        w.recognize(image),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("OCR timed out")), 30_000)),
      ]);
      return cleanOcr(data.text as string);
    });
    queue = job.catch(() => null); // serialize: one OCR at a time
    return job;
  };
}

/** Keep lines that look like medicine entries; drop doctor/clinic boilerplate. */
export function cleanOcr(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/[|_~`]/g, " ").replace(/\s+/g, " ").trim())
    .filter((l) => l.length >= 3 && /[a-z]{3}/i.test(l))
    .filter((l) => !/\b(dr\.?|doctor|clinic|hospital|patient|name|age|date|sign|reg\.?\s*no|address|phone|mobile|diagnosis|advice|follow)\b/i.test(l))
    .map((l) => l.replace(/^\s*(?:rx|℞)\s*[:.-]?\s*/i, "").replace(/^\s*(?:tab|cap|syp)\.?\s+/i, (m) => m))
    .slice(0, 15)
    .join("\n");
}

const Lines = z.object({
  medicines: z.array(z.string()).describe("Each medicine line exactly as written: name, strength, form. Omit dosing instructions."),
});

function claudeExtractor(apiKey: string, model: string, fallback: Extractor): Extractor {
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 45_000 });
  return async (image, mime) => {
    try {
      const response = await client.beta.messages.parse({
        model,
        max_tokens: 2000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low", format: betaZodOutputFormat(Lines) },
        system:
          "You transcribe medicine names from prescription photos for a pharmacy-availability app. " +
          "List only the medicine lines you can actually read: brand or salt name, strength and form as written. " +
          "Do not guess illegible words, do not correct, substitute or add medicines, and do not include dosing schedules. " +
          "If nothing is legible, return an empty list.",
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mime as "image/jpeg", data: image.toString("base64") } },
              { type: "text", text: "Transcribe the medicine lines on this prescription." },
            ],
          },
        ],
      });
      if (response.stop_reason === "refusal" || !response.parsed_output) return fallback(image, mime);
      return response.parsed_output.medicines.slice(0, 15).join("\n");
    } catch (e) {
      if (e instanceof Anthropic.APIError) console.error(`[extract] Claude ${e.status}: ${e.message}; using local OCR`);
      else console.error("[extract]", e);
      return fallback(image, mime);
    }
  };
}
