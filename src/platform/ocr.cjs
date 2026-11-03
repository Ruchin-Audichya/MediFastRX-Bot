const fs = require("node:fs/promises"),
  path = require("node:path"),
  crypto = require("node:crypto");
const sharp = require("sharp");
const { createWorker } = require("tesseract.js");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);
const langPath = path.dirname(
  require.resolve("@tesseract.js-data/eng/4.0.0/eng.traineddata.gz"),
);
function createOcr(
  platform,
  catalog,
  { directory = path.resolve(".local/private-prescriptions"), recognize } = {},
) {
  let busy = false;
  async function extract(buffer) {
    const worker = await createWorker("eng", 1, {
      langPath,
      cachePath: path.resolve(".local/ocr-cache"),
      logger: () => {},
    });
    let timer;
    try {
      return await Promise.race([
        worker.recognize(buffer),
        new Promise(
          (_, reject) =>
            (timer = setTimeout(
              () =>
                reject(
                  Error("OCR took too long. Try a clearer, smaller image."),
                ),
              30000,
            )),
        ),
      ]);
    } finally {
      clearTimeout(timer);
      await worker.terminate();
    }
  }
  function candidates(text) {
    return text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 30)
      .map((line) => {
        const cleaned = line
          .replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "")
          .replace(/\b(?:tab\.?|tablets?)\b/gi, "tablet")
          .replace(/\bcap\.?\b/gi, "capsule");
        const r = catalog.resolve(cleaned);
        return { text: cleaned, status: r.status, candidates: r.candidates };
      })
      .filter((x) => x.candidates.length);
  }
  async function upload(u, file) {
    if (!file) platform.fail("Choose a PNG, JPEG, WebP or PDF (up to 5 MB).");
    if (u.id === "demo-customer") {
      const sample = await fs.readFile(
        path.resolve("public/demo-prescription.png"),
      );
      if (!file.buffer.equals(sample))
        platform.fail(
          "The shared demo account only accepts the fictional sample. Create your own account to scan another document.",
        );
    }
    if (
      platform.db
        .prepare("SELECT count(*) n FROM prescriptions WHERE user_id=?")
        .get(u.id).n >= 50
    )
      platform.fail(
        "Your 50-document limit is reached. Delete older uploads first.",
        409,
      );
    if (busy)
      platform.fail("Another scan is processing. Try again shortly.", 429);
    busy = true;
    let temp;
    const id = crypto.randomUUID();
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      let images = [],
        stored,
        mime;
      if (file.buffer.subarray(0, 5).toString() === "%PDF-") {
        temp = path.join(directory, `${id}-input.pdf`);
        await fs.writeFile(temp, file.buffer, { mode: 0o600 });
        const prefix = path.join(directory, `${id}-page`);
        try {
          await run(
            "pdftoppm",
            ["-f", "1", "-l", "3", "-scale-to", "2000", "-png", temp, prefix],
            { timeout: 15000, maxBuffer: 1024 * 1024 },
          );
        } catch {
          platform.fail(
            "Could not render PDF. Use a PNG/JPEG, or install Poppler (pdftoppm).",
          );
        }
        const names = (await fs.readdir(directory))
          .filter((n) => n.startsWith(`${id}-page`) && n.endsWith(".png"))
          .sort();
        for (const n of names) {
          images.push(await fs.readFile(path.join(directory, n)));
          await fs.unlink(path.join(directory, n));
        }
        stored = file.buffer;
        mime = "application/pdf";
      } else {
        let metadata;
        try {
          metadata = await sharp(file.buffer, {
            limitInputPixels: 16000000,
          }).metadata();
        } catch {
          platform.fail("This is not a readable image. Use PNG, JPEG or WebP.");
        }
        if (!["png", "jpeg", "webp"].includes(metadata.format))
          platform.fail(
            "Use PNG, JPEG or WebP. SVG and animated formats are not accepted.",
          );
        const safe = await sharp(file.buffer, { limitInputPixels: 16000000 })
          .rotate()
          .resize({
            width: 2000,
            height: 2500,
            fit: "inside",
            withoutEnlargement: true,
          })
          .png()
          .toBuffer();
        images = [safe];
        stored = safe;
        mime = "image/png";
      }
      const output = [];
      for (const image of images) {
        const r = await (recognize || extract)(image);
        output.push(r.data || r);
      }
      const text = output
          .map((r) => r.text || "")
          .join("\n")
          .slice(0, 10000),
        confidence = output.length
          ? output.reduce((a, r) => a + (Number(r.confidence) || 0), 0) /
            output.length
          : 0;
      const filePath = path.join(
        directory,
        `${id}${mime === "application/pdf" ? ".pdf" : ".png"}`,
      );
      await fs.writeFile(filePath, stored, { mode: 0o600 });
      platform.db
        .prepare("INSERT INTO prescriptions VALUES (?,?,?,?,?,?)")
        .run(id, u.id, filePath, mime, text, platform.now());
      platform.audit(u.id, "prescription.uploaded", id);
      return {
        id,
        text,
        confidence: Math.round(confidence),
        candidates: candidates(text),
        unreadable: !text.trim(),
        notice:
          "Machine-read text, not an approved prescription. Check every name, strength and formulation. PDF scanning covers the first three pages only.",
      };
    } finally {
      busy = false;
      if (temp) await fs.unlink(temp).catch(() => {});
      for (const name of await fs.readdir(directory).catch(() => [])) {
        if (name.startsWith(`${id}-page`))
          await fs.unlink(path.join(directory, name)).catch(() => {});
      }
    }
  }
  function access(u, id) {
    const r = platform.db
      .prepare("SELECT * FROM prescriptions WHERE id=? AND created_at>?")
      .get(id, platform.now() - 7 * 86400000);
    if (!r) platform.fail("Prescription not found or expired.", 404);
    const assigned =
      u.role === "pharmacy" &&
      platform.db
        .prepare(
          "SELECT id FROM requests WHERE prescription_id=? AND pharmacy_id=? LIMIT 1",
        )
        .get(id, platform.ownPartner(u) || "");
    if (r.user_id !== u.id && !assigned)
      platform.fail("Prescription not found.", 404);
    return r;
  }
  async function remove(u, id) {
    const r = platform.db
      .prepare("SELECT * FROM prescriptions WHERE id=? AND user_id=?")
      .get(id, u.id);
    if (!r) platform.fail("Prescription not found.", 404);
    await fs.unlink(r.path).catch(() => {});
    platform.db.prepare("DELETE FROM prescriptions WHERE id=?").run(id);
    platform.audit(u.id, "prescription.deleted", id);
  }
  async function cleanup() {
    for (const r of platform.db
      .prepare("SELECT id,path FROM prescriptions WHERE created_at<=?")
      .all(platform.now() - 7 * 86400000)) {
      await fs.unlink(r.path).catch(() => {});
      platform.db.prepare("DELETE FROM prescriptions WHERE id=?").run(r.id);
    }
  }
  return { upload, access, remove, cleanup, candidates };
}
module.exports = { createOcr };
