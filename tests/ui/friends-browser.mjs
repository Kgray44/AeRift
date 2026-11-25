import assert from "node:assert/strict";
import { verifyFriendProfiles } from "./friends-profile-browser.mjs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const playwright = process.env.AERIFT_FRIENDS_PLAYWRIGHT;
const { chromium } = await import(playwright ? pathToFileURL(resolve(playwright)).href : "playwright");
const browser = await chromium.launch({ executablePath: process.env.AERIFT_FRIENDS_BROWSER });
const base = process.env.AERIFT_FRIENDS_URL ?? "http://127.0.0.1:47782";
const waitForButtonFocus = (page, label) => page.waitForFunction(
  expected => document.activeElement?.matches("button") && document.activeElement.getAttribute("aria-label") === expected,
  label,
);
try {
  const desktop = await browser.newPage({ viewport: { width: 1250, height: 900 } });
  await desktop.goto(base + "/desktop-visual.html?route=friends&friendsFixture=1");
  await desktop.getByRole("button", { name: "Test contact A" }).click();
  await desktop.getByRole("heading", { name: "Test contact A" }).waitFor();
  assert.equal(await desktop.getByRole("button", { name: "Test contact B" }).isVisible(), true);
  const panels = await desktop.locator(".ae-friends > .ae-surface").evaluateAll(panels => panels.map(panel => panel.getBoundingClientRect().x));
  assert.ok(panels[0] < panels[1], "desktop panes are side-by-side");
  assert.equal(await desktop.getByRole("heading", { name: "Device enrollment" }).count(), 0);
  assert.equal(await desktop.getByLabel("Received private invitation").count(), 0);
  assert.equal(await desktop.getByLabel("Your reachable private IPv4 address").isVisible(), false);
  const commands = () => desktop.evaluate(() => window.__aeWindowsFriendsFixtureCommands);
  assert.equal((await commands()).includes("friends_member:view"), false);
  assert.equal((await commands()).includes("friends_files_view"), false);
  assert.equal(await desktop.getByRole("button", { name: "Revoke", exact: true }).count(), 0);

  const addFriend = desktop.getByRole("button", { name: "Add a friend", exact: true });
  assert.equal(await addFriend.getAttribute("aria-haspopup"), "dialog");
  assert.ok(await addFriend.locator("svg").isVisible(), "the Add a friend control is icon-first");
  const pairDialog = desktop.getByRole("dialog", { name: "Friends", exact: true });
  const reviewInvitation = desktop.getByRole("button", { name: "Review friendship invitation" });
  await reviewInvitation.click();
  await pairDialog.waitFor();
  assert.equal(await pairDialog.evaluate(node => node.matches(":modal")), true);
  assert.equal(await pairDialog.getByRole("button", { name: "Close Friends" }).evaluate(node => document.activeElement === node), true);
  await desktop.keyboard.press("Shift+Tab");
  assert.equal(await desktop.evaluate(() => !document.activeElement?.closest(".ae-friends-list")), true, "modal prevents keyboard focus from reaching background");
  await pairDialog.getByRole("button", { name: "Verify and approve friendship" }).click();
  await pairDialog.getByRole("button", { name: "Verify and approve friendship" }).waitFor({ state: "hidden" });
  await pairDialog.getByRole("button", { name: "Show my private contact card" }).click();
  assert.equal(await pairDialog.getByLabel("Share this card privately with your friend").inputValue(), "fixture-card");
  if (process.env.AERIFT_FRIENDS_PAIR_SCREENSHOT) {
    await desktop.screenshot({ path: process.env.AERIFT_FRIENDS_PAIR_SCREENSHOT, animations: "disabled" });
  }
  await desktop.keyboard.press("Escape");
  await pairDialog.waitFor({ state: "hidden" });
  await addFriend.press("Enter");
  await pairDialog.waitFor();
  await pairDialog.getByRole("button", { name: "Close Friends" }).click();
  await pairDialog.waitFor({ state: "hidden" });
  await waitForButtonFocus(desktop, "Add a friend");
  await desktop.getByRole("button", { name: "Send a file to Test contact A" }).click();
  await desktop.getByRole("heading", { name: "Private transfers" }).waitFor();
  await desktop.getByLabel("Your reachable private IPv4 address").fill("100.64.0.1");
  await desktop.getByRole("button", { name: "Open five-minute transfer window" }).click();
  await desktop.getByText("Transfer window open", { exact: true }).waitFor();
  assert.equal(await desktop.getByRole("combobox", { name: "Friend", exact: true }).inputValue(), "friend-a");
  await desktop.getByLabel("Their authorized device").selectOption("friend-phone");
  await desktop.getByLabel("Their offer address").fill("100.64.0.2:54000");
  await desktop.getByLabel("Their payload address").fill("100.64.0.2:54001");
  await desktop.getByRole("button", { name: "Choose a file and send offer" }).click();
  await desktop.getByText("Waiting for acceptance. No file has been sent.").waitFor();
  assert.equal(await desktop.getByRole("button", { name: "Send accepted file" }).isEnabled(), false);
  await desktop.getByRole("button", { name: "Back to friend details" }).click();
  await desktop.getByRole("button", { name: "Enroll a device" }).click();
  await desktop.getByRole("heading", { name: "Device enrollment" }).waitFor();
  await desktop.getByLabel("Your role").waitFor();
  await desktop.getByRole("button", { name: "Back to friend details" }).click();
  await desktop.getByRole("button", { name: "Private transfers", exact: true }).click();
  await desktop.getByText("Waiting for acceptance. No file has been sent.").waitFor();
  assert.equal((await commands()).includes("friends_files_action:send"), false);
  // Test fixture simulates the remote peer's authenticated consent. There is
  // no page control that can substitute consent in the installed application.
  await desktop.evaluate(() => window.__aeWindowsFriendsFixtureAcceptManualOffer());
  await desktop.getByRole("button", { name: "Send accepted file" }).click();
  await desktop.getByText("File received and verified: 4,299 bytes.").waitFor();
  await desktop.getByRole("button", { name: "Close transfer window" }).click();
  await desktop.getByRole("button", { name: "Open five-minute transfer window" }).waitFor();
  const calls = await commands();
  for (const command of ["friends_setup_answer", "friends_files_action:offer", "friends_files_action:send",
    "friends_files_action:close", "friends_member:view"]) assert.ok(calls.includes(command), command);
  assert.equal(calls.filter(command => command === "friends_files_action:send").length, 1);
  assert.equal(calls.includes("friends_files_action:offer_contact"), false);
  await desktop.getByRole("button", { name: "Back to friend details" }).click();
  if (process.env.AERIFT_FRIENDS_SCREENSHOT) {
    await desktop.screenshot({ path: process.env.AERIFT_FRIENDS_SCREENSHOT, animations: "disabled" });
  }
  const empty = await browser.newPage({ viewport: { width: 850, height: 800 }, reducedMotion: "reduce" });
  await empty.goto(base + "/desktop-visual.html?route=friends&friendsFixture=1&state=empty&scheme=light");
  await empty.getByRole("heading", { name: "No friends yet" }).waitFor();
  assert.equal(await empty.getByRole("button", { name: "Add a friend", exact: true }).isVisible(), true);
  assert.equal(await empty.getByRole("button", { name: "Enroll a device" }).isVisible(), true);
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  await phone.goto(base + "/mobile.html");
  await phone.getByRole("button", { name: "Devices", exact: true }).waitFor();
  assert.equal(await phone.getByRole("button", { name: "Friends" }).count(), 0);
  await phone.goto(base + "/mobile.html?friendsFixture=1");
  await phone.getByRole("button", { name: "Devices", exact: true }).click();
  const nearby = phone.getByRole("region", { name: "Nearby Devices" });
  await nearby.getByText("Studio PC", { exact: true }).waitFor();
  assert.equal(await nearby.getByText("Test phone", { exact: true }).count(), 0);
  assert.equal(await phone.getByText("Test phone", { exact: true }).count(), 0,
    "a known Friends device is not mounted in the hidden ordinary composer");
  await phone.getByRole("button", { name: "Rift", exact: true }).click();
  const ordinaryPicker = phone.getByRole("radiogroup", { name: "Destination device" });
  const studio = ordinaryPicker.locator("label.ae-spatial-peer").filter({ hasText: "Studio PC" });
  await studio.waitFor();
  assert.equal(await phone.getByText("Test phone", { exact: true }).count(), 0,
    "the active ordinary picker excludes Friends devices too");
  const manual = phone.getByRole("region", { name: "Manual transfer", exact: true });
  await manual.getByRole("button", { name: "Choose another file" }).click();
  await manual.getByText("Harbor survey.pdf", { exact: true }).waitFor();
  await studio.click();
  await manual.getByRole("button", { name: "Send file", exact: true }).waitFor();
  assert.equal(await manual.getByRole("button", { name: "Send file", exact: true }).isEnabled(), true);
  await phone.getByRole("button", { name: "Friends", exact: true }).click();
  const mobileAddFriend = phone.getByRole("button", { name: "Add a friend", exact: true });
  await mobileAddFriend.click();
  const mobilePair = phone.getByRole("dialog", { name: "Friends", exact: true });
  await mobilePair.waitFor();
  assert.equal(await mobilePair.evaluate(node => getComputedStyle(node).animationName), "none");
  await mobilePair.getByRole("button", { name: "Show my private contact card" }).click();
  assert.equal(await mobilePair.getByLabel("Your private contact card").inputValue(), "fixture-card");
  const generate = mobilePair.getByRole("button", { name: "Create targeted invitation" });
  assert.equal(await generate.isEnabled(), false);
  await mobilePair.getByLabel("Recipient’s private contact card").fill("recipient-fixture-card");
  await generate.click();
  assert.equal(await mobilePair.getByLabel("Private invitation", { exact: true }).inputValue(), "test-fixture");
  await mobilePair.getByRole("button", { name: "Close Friends" }).click();
  await mobilePair.waitFor({ state: "hidden" });
  await waitForButtonFocus(phone, "Add a friend");
  await phone.getByRole("button", { name: "Test contact A" }).click();
  assert.equal(await phone.getByRole("button", { name: "Test contact B" }).isVisible(), false);
  assert.equal(await phone.getByRole("heading", { name: "Test contact A" }).evaluate(node => document.activeElement === node), true);
  assert.equal(await phone.locator(".ae-friends-detail").evaluate(node => getComputedStyle(node).animationName), "none");
  await phone.getByRole("region", { name: "Send to friend" }).getByRole("combobox", { name: /^Send to/ }).selectOption("friend-phone");
  await phone.getByRole("button", { name: "File", exact: true }).click();
  await phone.getByRole("button", { name: "Send offer" }).click();
  const friendTransfers = phone.getByRole("region", { name: "Pending transfers and history", exact: true });
  await friendTransfers.getByText("Synthetic sample · queued", { exact: true }).waitFor();
  await friendTransfers.getByRole("button", { name: "Accept", exact: true }).click();
  await friendTransfers.getByText("Incoming fixture · accepted", { exact: true }).waitFor();
  await phone.getByRole("button", { name: "Back to friends" }).click();
  await phone.getByRole("button", { name: "Test contact B" }).click();
  assert.equal(await phone.locator(".ae-friends-detail option").count(), 2);
  assert.equal(await phone.locator(".ae-friends-detail option[value='friend-phone']").count(), 0);
  assert.equal(await phone.getByText("Synthetic sample · queued").count(), 0);
  await verifyFriendProfiles(browser, base);
  console.log("Friends desktop two-pane and mobile list/detail, capability gating, recipient scoping, confirm/send and native snapshots verified with synthetic IPC.");
} finally { await browser.close(); }
