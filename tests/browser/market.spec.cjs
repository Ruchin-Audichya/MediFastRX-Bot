const { test, expect } = require("@playwright/test");
async function signIn(page, role) {
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: `Demo ${role}`, exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Account", exact: true }),
  ).toBeVisible();
}
test("two independent sessions complete pharmacist review and receive live pickup updates", async ({
  page,
  browser,
}, info) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page, "customer");
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  await page.getByRole("button", { name: "Dolo 650", exact: true }).click();
  await page
    .getByRole("button", { name: "Request this exact medicine" })
    .click();
  await expect(
    page.getByText("Demo · confirmed in stock", { exact: true }),
  ).toBeVisible();
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/platform/requests") &&
      r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Request availability", exact: true })
    .click();
  const created = await (await response).json();
  const card = page
    .locator(".request-card")
    .filter({ hasText: created.id.slice(0, 8) });
  await expect(card.locator(".status-pill")).toHaveText("Submitted");
  const context = await browser.newContext({
    baseURL: new URL(page.url()).origin,
    viewport:
      info.project.name === "phone"
        ? { width: 390, height: 844 }
        : { width: 1440, height: 1000 },
  });
  const operator = await context.newPage();
  operator.on("pageerror", (e) => errors.push(e.message));
  try {
    await signIn(operator, "pharmacy");
    const inbox = operator
      .locator(".request-card")
      .filter({ hasText: created.id.slice(0, 8) });
    await inbox
      .getByRole("button", { name: "Start review", exact: true })
      .click();
    await expect(card.locator(".status-pill")).toHaveText("Pharmacy reviewing");
    await expect(
      inbox.getByRole("button", { name: "Confirm & reserve stock" }),
    ).toBeDisabled();
    await inbox.getByRole("checkbox").check();
    await inbox
      .getByLabel("Review note", { exact: true })
      .fill("Demo: original, brand, strength, formulation and pack checked.");
    await inbox
      .getByRole("button", { name: "Confirm & reserve stock" })
      .click();
    await expect(card.locator(".status-pill")).toHaveText("Confirmed");
    await expect(card).toContainText("₹30.00");
    await operator.screenshot({
      path: `.local/v2-pharmacy-${info.project.name}.png`,
      fullPage: true,
    });
    for (const [button, status] of [
      ["Start preparing", "Preparing"],
      ["Mark ready for pickup", "Ready for pickup"],
      ["Complete request", "Completed"],
    ]) {
      await inbox.getByRole("button", { name: button, exact: true }).click();
      await expect(card.locator(".status-pill")).toHaveText(status);
    }
    await page.screenshot({
      path: `.local/v2-customer-${info.project.name}.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    expect(
      await operator.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
test("actual OCR extracts editable candidates and builds a confirmed multi-medicine list", async ({
  page,
}, info) => {
  test.setTimeout(90000);
  await signIn(page, "customer");
  await page.getByRole("button", { name: "Scan", exact: true }).click();
  await page
    .getByRole("button", { name: "Use clearly fictional demo image" })
    .click();
  await page.getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "Scan prescription", exact: true })
    .click();
  await expect(page.getByLabel("Editable medicine lines")).toContainText(
    /Dolo 650 mg tablet/,
    { timeout: 60000 },
  );
  await expect(page.getByLabel("Editable medicine lines")).toContainText(
    /Cetirizine 10 mg tablet/,
  );
  await page
    .getByLabel("Editable medicine lines")
    .fill("Dolo 650 mg tablet\nCetirizine 10 mg tablet\nNoSuchDrug");
  await page.getByRole("button", { name: "Find medicine candidates" }).click();
  await expect(
    page.getByText("No safe match. Correct the line above and look up again."),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Dolo · 650 mg · tablet", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Cetirizine · 10 mg · tablet", exact: true })
    .click();
  await page.screenshot({
    path: `.local/v2-scanner-${info.project.name}.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Find these medicines" }).click();
  await expect(page.locator(".basket-item")).toHaveCount(2);
  await expect(
    page.getByText("All selected products have a fresh positive stock report."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Show map", exact: true }).click();
  await expect(page.locator(".leaflet-container")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});
test("operator CSV import previews exact rows and manual stock update persists", async ({
  page,
}) => {
  await signIn(page, "pharmacy");
  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await page
    .getByLabel("Stock CSV", { exact: true })
    .fill(
      "Item Name,Strength,Form,Closing Stock,Unit,MRP\nDolo,650 mg,tablet,20,strip of 15 tablets,30\nDolo,500 mg,tablet,5,strip of 10 tablets,20",
    );
  await page
    .getByRole("button", { name: "Preview import", exact: true })
    .click();
  await expect(
    page.getByText("1 exact products ready. 1 rows skipped."),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Apply reviewed stock updates" })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Inventory import applied",
  );
  await page
    .getByLabel("Medicine to list", { exact: true })
    .fill("Cetirizine 10 mg tablet");
  await page.getByRole("button", { name: "Look up", exact: true }).click();
  await page
    .getByRole("button", { name: "Cetirizine · 10 mg · tablet", exact: true })
    .click();
  await page.getByLabel("Available packs", { exact: true }).fill("18");
  await page
    .getByLabel("Price per listed unit (INR)", { exact: true })
    .fill("25");
  await page.getByRole("button", { name: "Save stock report" }).click();
  await expect(page.locator(".notice[role=status]")).toContainText(
    "Inventory updated",
  );
  await expect(page.locator(".inventory-list")).toContainText("18 available");
});
test("admin source review, audit and provider disabled states are functional", async ({
  page,
}, info) => {
  await signIn(page, "admin");
  await expect(
    page.getByText("DEMO · APPROVED", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "catalog", exact: true }).click();
  await page
    .getByRole("button", { name: "Record source review" })
    .first()
    .click();
  await expect(
    page.getByText(
      "Source review: Not recorded. Clinical verification is not implied.",
    ),
  ).not.toHaveCount(9);
  await page.getByRole("button", { name: "audit", exact: true }).click();
  await expect(
    page
      .getByRole("cell", { name: "catalog.source_review", exact: true })
      .first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "health", exact: true }).click();
  await expect(
    page.getByText("payments: disabled", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: `.local/v2-admin-${info.project.name}.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});
test("Hinglish and unsupported voice have useful deterministic behavior", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "SpeechRecognition", { value: undefined });
    Object.defineProperty(window, "webkitSpeechRecognition", {
      value: undefined,
    });
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Speak a medicine name", exact: true })
    .click();
  await expect(page.getByText(/Voice input is not supported/)).toBeVisible();
  await page.getByLabel("Search a medicine").fill("Mujhe Dolo 650 chahiye");
  await page
    .getByRole("button", { name: "Search medicine", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Dolo", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Ask a follow-up").fill("Mere aas paas kaha milegi?");
  await page.getByRole("button", { name: "Send follow-up" }).click();
  await expect(
    page.getByRole("heading", { name: /Find your pack/ }),
  ).toBeVisible();
});
