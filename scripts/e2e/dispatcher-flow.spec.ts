/**
 * E2E (spec §16): dispatcher creates a trip for a phone caller in the staff
 * console; auto-dispatch assigns a sim driver; the board reflects it.
 */
import { expect, test } from "@playwright/test";
import type { SimDriver } from "../src/sim-driver";
import { resetWorld, spawnAcceptingDriver, teardown } from "./helpers";

let driver: SimDriver;

test.beforeAll(async () => {
  await resetWorld();
  driver = await spawnAcceptingDriver();
});

test.afterAll(async () => {
  await teardown(driver);
});

test("dispatcher books for a phone caller and sees the driver assigned on the board", async ({ page }) => {
  // Real staff password login (Argon2id).
  await page.goto("/staff/login");
  await page.getByPlaceholder("+2557XXXXXXXX").fill("+255700000002");
  await page.getByPlaceholder("Password").fill("ChangeMe123!");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/staff\/dispatch/, { timeout: 15_000 });

  // Live map/list shows the online sim driver.
  await expect(page.getByText(/Online drivers/)).toBeVisible();
  await expect(page.getByText(/Sim Driver/).first()).toBeVisible({ timeout: 15_000 });

  // Book for a caller: phone + landmark pickup/destination (spec §13).
  await page.getByPlaceholder(/Caller phone/).fill("+255789555001");
  await page.getByPlaceholder(/Pickup landmark/).fill("bus station");
  await page.getByRole("button", { name: /Sumbawanga bus station/ }).click();
  await page.getByPlaceholder(/Destination landmark/).fill("Soko Kuu");
  await page.getByRole("button", { name: /Soko Kuu/ }).first().click();
  await page.getByRole("button", { name: /Book & auto-dispatch/ }).click();
  await expect(page.getByText(/Create trip: OK/)).toBeVisible({ timeout: 15_000 });

  // The board shows the caller's trip, then the assigned driver (5 s poll).
  await expect(page.getByText("+255789555001")).toBeVisible({ timeout: 15_000 });
  const row = page.locator("tr", { hasText: "+255789555001" });
  await expect(row.getByText(/Sim Driver \d+/)).toBeVisible({ timeout: 45_000 });
});
