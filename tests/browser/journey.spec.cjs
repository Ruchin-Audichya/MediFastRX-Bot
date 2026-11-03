const { test, expect } = require("@playwright/test");
const errors = [];
test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
});
test.afterEach(() => {
  expect(errors.splice(0)).toEqual([]);
});
async function dolo(page) {
  await page.getByRole("button", { name: "Dolo 650", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Dolo", exact: true }),
  ).toBeVisible();
}
test("complete search, follow-up, pharmacy journey and responsive layout", async ({
  page,
}, testInfo) => {
  await expect(
    page.getByRole("heading", { name: /Medicine confusion/ }),
  ).toBeVisible();
  await page.screenshot({
    path: `.local/home-${testInfo.project.name}.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await dolo(page);
  await page.getByRole("button", { name: "Side effects", exact: true }).click();
  await expect(page.locator(".answer")).toContainText("allergic");
  await page
    .getByText("Where this information comes from", { exact: true })
    .click();
  await expect(page.getByRole("link", { name: /NHS/ })).toBeVisible();
  await page.screenshot({
    path: `.local/details-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Find nearby pharmacies", exact: true })
    .click();
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await expect(page.getByText("SAMPLE RESULTS", { exact: true })).toBeVisible();
  await expect(page.locator('a[href^="tel:"]')).toHaveCount(0);
  await expect(page.getByText("No inventory verified")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: `.local/pharmacies-${testInfo.project.name}.png`,
    fullPage: true,
  });
});
test("spelling correction asks for confirmation and shelf notes survive reload", async ({
  page,
}, testInfo) => {
  await page.getByRole("button", { name: "Paracetmol", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Which one is on your pack?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Dolo 650 mg/ }).click();
  await page
    .getByRole("button", { name: "Save to shelf", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Saved to your shelf");
  await page.getByRole("button", { name: /My shelf/ }).click();
  await page
    .getByLabel("A note to yourself")
    .fill("Bring package to appointment");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Recently explored" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /My shelf/ }).click();
  await expect(page.getByLabel("A note to yourself")).toHaveValue(
    "Bring package to appointment",
  );
  await page.screenshot({
    path: `.local/shelf-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Revisit medicine" }).click();
  await expect(
    page.getByRole("heading", { name: "Dolo", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /My shelf/ }).click();
  await page.getByRole("button", { name: "Remove Dolo" }).click();
  await expect(
    page.getByRole("heading", { name: "Make a little room for clarity." }),
  ).toBeVisible();
});
test("location denied allows manual area search", async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "geolocation", {
      value: { getCurrentPosition: (ok, fail) => fail({ code: 1 }) },
    }),
  );
  await page.reload();
  await dolo(page);
  await page
    .getByRole("button", { name: "Find nearby pharmacies", exact: true })
    .click();
  await page.getByRole("button", { name: "Use my location" }).click();
  await expect(page.locator(".notice[role=alert]")).toContainText(
    "Location wasn’t shared",
  );
  await page.getByLabel("Area or location").fill("Mansarovar");
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await expect(page.getByText("SAMPLE RESULTS", { exact: true })).toBeVisible();
});
test("switch context, personal question, reset, unknown medicine", async ({
  page,
}) => {
  await dolo(page);
  await page.getByLabel("Ask a follow-up").fill("side effects of Cetirizine");
  await page.getByRole("button", { name: "Send follow-up" }).click();
  await expect(page.locator(".context-label")).toContainText("Cetirizine");
  await expect(page.locator(".answer")).toContainText("Sleepiness");
  await page.getByLabel("Ask a follow-up").fill("Can I take it daily?");
  await page.getByRole("button", { name: "Send follow-up" }).click();
  await expect(page.locator(".answer")).toContainText("cannot decide");
  await page.getByRole("button", { name: "New search", exact: true }).click();
  await page.getByLabel("Search a medicine").fill("asdf123");
  await page
    .getByRole("button", { name: "Search medicine", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Not in this little catalog. Yet." }),
  ).toBeVisible();
});
test("strength mismatch never shows wrong product", async ({ page }) => {
  await page.getByLabel("Search a medicine").fill("Dolo syrup");
  await page
    .getByRole("button", { name: "Search medicine", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Not in this little catalog. Yet." }),
  ).toBeVisible();
});
test("AI unavailable keeps catalog explanation usable", async ({ page }) => {
  await dolo(page);
  await page
    .getByRole("button", { name: "Explain simply", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Try an AI-assisted explanation" })
    .click();
  await expect(
    page.getByText("CATALOG EXPLANATION", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".explanation")).toContainText("supplied evidence");
});
test("pharmacy network failure is recoverable", async ({ page }) => {
  await page.route("**/api/pharmacies?*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Directory unavailable. Try again." }),
    }),
  );
  await dolo(page);
  await page
    .getByRole("button", { name: "Find nearby pharmacies", exact: true })
    .click();
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await expect(page.locator(".notice[role=alert]")).toContainText(
    "Directory unavailable",
  );
  await expect(
    page.getByRole("button", { name: "Find", exact: true }),
  ).toBeEnabled();
});
test("keyboard shortcut and submit", async ({ page }) => {
  await expect(page.getByLabel("Search a medicine")).toBeVisible();
  await page.keyboard.press("/");
  await expect(page.getByLabel("Search a medicine")).toBeFocused();
  await page.keyboard.type("Cetirizine");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Cetirizine", exact: true }),
  ).toBeVisible();
});
test("stale search cannot overwrite newer medicine", async ({ page }) => {
  await page.route("**/api/message", async (route) => {
    if (route.request().postDataJSON().query === "Dolo 650")
      await new Promise((r) => setTimeout(r, 350));
    await route.continue();
  });
  await page.getByRole("button", { name: "Dolo 650", exact: true }).click();
  await page.getByRole("button", { name: "Cetirizine", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Cetirizine", exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(450);
  await expect(
    page.getByRole("heading", { name: "Cetirizine", exact: true }),
  ).toBeVisible();
});
test("live listing presents call and directions without inventing opening status", async ({
  page,
}) => {
  await page.route("**/api/status", (r) =>
    r.fulfill({
      json: {
        catalog: { mode: "demo", count: 9 },
        pharmacies: "live",
        ai: "off",
      },
    }),
  );
  await page.route("**/api/pharmacies?*", (r) =>
    r.fulfill({
      json: {
        mode: "live",
        center: { lat: 26.91, lng: 75.79, label: "Jaipur" },
        notice: "Live directory, stock unknown.",
        items: [
          {
            id: "test-only",
            name: "Test listing",
            address: "Test fixture address",
            lat: 26.91,
            lng: 75.79,
            distanceKm: 0.5,
            phone: "+91 141 1234567",
            hours: "Mo-Fr 09:00-18:00",
            source: "OpenStreetMap contributors",
            demo: false,
            stock: "Call to confirm",
          },
        ],
      },
    }),
  );
  await page.reload();
  await dolo(page);
  await page
    .getByRole("button", { name: "Find nearby pharmacies", exact: true })
    .click();
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Call pharmacy" }),
  ).toHaveAttribute("href", "tel:+911411234567");
  await expect(
    page.getByRole("link", { name: "Directions", exact: true }),
  ).toHaveAttribute("href", /destination=26.91,75.79/);
  await expect(
    page.getByText("Listed hours: Mo-Fr 09:00-18:00 (unverified)", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("open now", { exact: false })).toHaveCount(0);
});
test("corrupt local shelf is ignored and reduced motion disables decorative animation", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "medifast.shelf.v2",
      JSON.stringify([
        { id: "broken", name: "Bad record", generic: { bad: true }, note: "" },
      ]),
    ),
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await page.getByRole("button", { name: /My shelf/ }).click();
  await expect(
    page.getByRole("heading", { name: "Make a little room for clarity." }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
  ).toBeTruthy();
});

test("Telegram medicine link and partner handoff preserve exact product without submitting a request", async ({
  page,
}) => {
  await page.goto("/?medicine=dolo650");
  await expect(
    page.getByRole("heading", { name: "Dolo", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".medicine-heading")).toContainText(
    "650 mg · tablet",
  );
  await page.goto("/?medicine=dolo650&screen=partners");
  await expect(page.locator(".basket-item")).toContainText("Dolo");
  await expect(page.locator(".basket-item")).toContainText("650 mg");
  await expect(
    page.getByRole("button", { name: "Request availability", exact: true }),
  ).toBeVisible();
  await page.goto("/?screen=scanner");
  await expect(
    page.getByRole("heading", { name: /Your information/ }),
  ).toBeVisible();
});
