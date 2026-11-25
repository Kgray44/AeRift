"use strict";
(() => {
  const q = id => document.getElementById(id);
  const invoke = action => window.__TAURI_INTERNALS__.invoke("private_wan_action", { action });
  const notice = text => { q("notice").textContent = text; };
  const loading = new Set();
  let poll;
  let inviteTimer;
  let previous = "";
  let open = true;
  const clearInvite = () => {
    clearTimeout(inviteTimer);
    q("my-invite").value = "";
    q("new-invite").hidden = true;
  };
  const safeFailure = error => {
    if (error?.code === "cancelled") return "No file was sent.";
    return "This action did not complete. Verify the device card, invitation, and connection, then try again.";
  };
  async function act(action, key, success) {
    if (!open || loading.has(key)) return;
    loading.add(key);
    try {
      const reply = await invoke(action);
      if (open) success?.(reply);
    } catch (error) {
      if (open) notice(safeFailure(error));
    } finally {
      loading.delete(key);
      if (open) void refresh();
    }
  }
  function button(title, onClick) {
    const value = document.createElement("button");
    value.type = "button";
    value.textContent = title;
    value.onclick = onClick;
    return value;
  }
  function entry(parent, label, children = []) {
    const row = document.createElement("div");
    row.className = "entry";
    const title = document.createElement("div");
    title.textContent = label;
    row.append(title, ...children);
    parent.append(row);
  }
  function setEmpty(parent, label) { const text = document.createElement("p"); text.textContent = label; parent.append(text); }
  async function refresh() {
    if (!open || document.hidden || loading.has("snapshot")) return;
    loading.add("snapshot");
    try {
      const data = await invoke({ type: "snapshot" });
      if (!open || data.type !== "snapshot") return;
      const changed = JSON.stringify(data);
      if (changed === previous) return;
      previous = changed;
      q("my-card").value = data.card;
      const devices = q("devices"), pairing = q("pairing"), offers = q("offers");
      devices.replaceChildren(); pairing.replaceChildren(); offers.replaceChildren();
      const pending = data.pending;
      if (pending) {
        entry(pairing, "Verify and approve " + pending.device.name + " (" + pending.device.id + ")", [true, false].map(allow =>
          button(allow ? "Approve connection" : "Decline connection", () => act({
            type: "pairDecision", request: pending.request, allow
          }, "pair", () => {
            clearInvite();
            notice(allow ? "Device connected." : "Connection declined.");
          }))
        ));
      }
      if (!data.devices.length) setEmpty(devices, "No device connected in this session.");
      for (const peer of data.devices) {
        entry(devices, peer.name, [
          button("Choose & send file", () => {
            notice("Choose a file in the Windows picker. The recipient must accept it.");
            void act({ type: "chooseAndSend", peer: peer.id }, "send", reply =>
              notice(reply.status?.state === "completed" ? "File delivered and verified." : "No delivery was confirmed."));
          }),
          button("Disconnect device", () => {
            if (window.confirm("Remove this device’s Remote access?")) void act({
              type: "revoke", peer: peer.id, confirmed: true
            }, "revoke", () => notice("Device access removed."));
          }),
        ]);
      }
      if (!data.offers.length) setEmpty(offers, "No incoming files.");
      for (const offer of data.offers) {
        const display = data.devices.find(device => device.id === offer.peer)?.name ?? "Remote device";
        const label = offer.name + " · " + display + " · " + offer.size.toLocaleString() + " bytes · " + offer.state;
        const controls = offer.state === "pending" ? [true, false].map(allow => button(
          allow ? "Accept file" : "Decline file",
          () => act({ type: "offerDecision", peer: offer.peer, offer: offer.offer, allow }, "offer-" + offer.offer,
            () => notice(allow ? "File accepted. Waiting for verified delivery." : "File declined."))
        )) : [];
        entry(offers, label, controls);
      }
    } catch {
      if (open) notice("The private Remote session is unavailable.");
    } finally {
      loading.delete("snapshot");
    }
  }
  async function copyField(id, text) {
    const field = q(id);
    if (!field.value) return;
    try {
      await navigator.clipboard.writeText(field.value);
      notice(text);
    } catch {
      field.select();
      notice("Press Ctrl+C to copy the selected text.");
    }
  }
  q("copy-card").onclick = () => copyField("my-card", "Device card copied. Share it privately.");
  q("copy-invite").onclick = () => copyField("my-invite", "Invitation copied. Share it privately.");
  q("cancel-invite").onclick = () => act({ type: "cancelInvite" }, "create", () => {
    clearInvite();
    notice("Invitation cancelled.");
  });
  q("create").onsubmit = event => {
    event.preventDefault();
    void act({ type: "createInvite", card: q("their-card").value.trim(),
      verified: q("recipient-verified").checked
    }, "create", reply => {
      clearInvite();
      q("my-invite").value = reply.code;
      q("new-invite").hidden = false;
      q("create").reset();
      inviteTimer = setTimeout(clearInvite, 5 * 60 * 1000);
      notice("Private invitation created.");
    });
  };
  q("redeem").onsubmit = event => {
    event.preventDefault();
    if (loading.has("redeem")) return;
    const action = { type: "redeem", issuerCard: q("issuer-card").value.trim(),
      code: q("their-invite").value.trim(), verified: q("issuer-verified").checked };
    q("redeem").reset();
    notice("Waiting for the sender to approve this device.");
    void act(action, "redeem", () => notice("Device connected."));
  };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
  window.addEventListener("pagehide", () => {
    open = false;
    clearInterval(poll);
    clearInvite();
    q("redeem").reset();
    q("create").reset();
  }, { once: true });
  poll = setInterval(refresh, 1000);
  void refresh();
})();
