import { test, expect } from "./support/test";

test("independent local and AWS sockets send and log fixture messages without external connections", async ({ page, studio }) => {
  await studio.goto("/websockets");
  const local = page.getByRole("region", { name: "Local", exact: true });
  const aws = page.getByRole("region", { name: "AWS", exact: true });
  await local.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(local.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible();
  await expect(aws.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
  await local.getByRole("textbox", { name: "Send payload", exact: true }).fill('{"action":"fixture"}');
  await local.getByRole("button", { name: "Send payload to Local" }).click();
  await expect(local.getByRole("log")).toContainText("1 item");
  // This selector belongs to the third-party JSON viewer, whose collapsed tree has no button role.
  await local.getByRole("log").locator(".collapsed-icon:visible").click();
  await expect(local.getByRole("log")).toContainText("received");
  expect(studio.sockets).toEqual(['{"action":"fixture"}']);
  await local.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(local.getByRole("log")).toContainText("Disconnected from WebSocket");
  await aws.getByRole("textbox", { name: "AWS connection URL" }).fill("invalid");
  await expect(aws.getByRole("button", { name: "Connect", exact: true })).toBeDisabled();
});
