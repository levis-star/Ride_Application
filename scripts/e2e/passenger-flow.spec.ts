/**
 * E2E (spec §16): passenger books in the PWA → sim driver accepts → trip
 * completes → receipt + rating. Runs in real Chromium against the live stack.
 */
import { expect, test } from "@playwright/test";
import type { SimDriver } from "../src/sim-driver";
import { passengerToken, resetWorld, spawnAcceptingDriver, teardown } from "./helpers";

let driver: SimDriver;

test.beforeAll(async () => {
  await resetWorld();
  driver = await spawnAcceptingDriver();
});

test.afterAll(async () => {
  await teardown(driver);
});

test("the CSP is enforced and lets the app (map, API, socket) work", async ({ page, context }) => {
  // Security assessment L-3: catch a Content-Security-Policy that is either
  // missing, or so strict it breaks the app's own map/API/socket calls.
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to (connect|load|execute)/i.test(m.text())) {
      violations.push(m.text());
    }
  });

  const { token } = await passengerToken(0);
  await context.addInitScript((t) => window.localStorage.setItem("rr_access", t), token);

  const res = await page.goto("/");
  const csp = res?.headers()["content-security-policy"] ?? "";
  expect(csp, "a CSP header must be present").toContain("default-src 'self'");
  expect(csp, "scripts must be nonce-locked, not unsafe-inline").toMatch(/script-src[^;]*'nonce-/);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");

  // The map (MapLibre blob workers + tile fetches) is the thing most likely to
  // break under CSP — render it and assert no violation fired.
  await expect(page.locator("canvas").first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  expect(violations, `CSP blocked something the app needs:\n${violations.join("\n")}`).toEqual([]);
});

test("passenger books → driver accepts → trip completes → receipt + rating", async ({ page, context }) => {
  const { token } = await passengerToken(0);
  await context.addInitScript((t) => window.localStorage.setItem("rr_access", t), token);

  await page.goto("/");
  // Destination via landmark search (no geocoding exists — spec §11).
  const search = page.getByPlaceholder(/Tafuta sehemu/);
  await expect(search).toBeVisible({ timeout: 15_000 });
  await search.fill("Soko Kuu");
  await page.getByText("Soko Kuu", { exact: true }).first().click();

  // Class picker with per-class estimates ("Kadirio").
  await expect(page.getByText(/Kadirio/)).toBeVisible();
  const bodaCard = page.getByRole("button", { name: /Bodaboda/ });
  await expect(bodaCard).toContainText(/TZS/);
  await bodaCard.click();
  await page.getByRole("button", { name: /Agiza sasa/ }).click();

  // Searching → driver assigned (LATRA identity card: name + plate).
  await expect(page).toHaveURL(/\/trip\//, { timeout: 15_000 });
  await expect(page.getByText(/Dereva anakuja|Dereva amefika/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/MC \d+ SIM/)).toBeVisible();
  await expect(page.getByRole("link", { name: /Mpigie dereva/ })).toBeVisible();

  // Live lifecycle through to completion (driver drives at sim speed).
  await expect(page.getByText(/Safari imekamilika/)).toBeVisible({ timeout: 150_000 });
  await expect(page.getByText(/TZS [\d,]+/).first()).toBeVisible();
  await expect(page.getByText(/Lipa kwa fedha taslimu/)).toBeVisible();

  // Rate the driver.
  await page.getByLabel("5 stars").click();
  await page.getByRole("button", { name: /^Tuma$/ }).click();
  await expect(page.getByRole("button", { name: /Nyumbani/ })).toBeVisible({ timeout: 10_000 });

  // Receipt shows up in history.
  await page.goto("/history");
  await expect(page.getByText("COMPLETED").first()).toBeVisible({ timeout: 10_000 });
});
