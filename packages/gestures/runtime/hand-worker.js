/* Adapted from VoyageWright Watchglass. See ../README.md for provenance. */
/* global importScripts */
var exports = {};
let detector = null;
let generation = 0;
let stage = "RUNTIME_LOAD";
self.onmessage = async ({ data }) => {
  if (data.type === "INIT") {
    generation = data.generation;
    try {
      importScripts("./vision_bundle.js");
      const { FilesetResolver, HandLandmarker } = exports;
      stage = "MODEL_FETCH";
      const model = await fetch(new URL("./hand_landmarker.task", self.location.href), { redirect: "error" }).then((r) => {
        if (!r.ok) throw new Error("MODEL_FETCH");
        return r.arrayBuffer();
      });
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", model)), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      stage = "MODEL_INTEGRITY";
      if (hash !== "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1")
        throw new Error("MODEL_INTEGRITY");
      stage = "RUNTIME_INIT";
      const fileset = await FilesetResolver.forVisionTasks(new URL("./wasm", self.location.href).href);
      stage = "MODEL_INIT";
      detector = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: new Uint8Array(model), delegate: "CPU" },
        runningMode: "VIDEO",
        numHands: 2,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.6,
        minTrackingConfidence: 0.6,
      });
      self.postMessage({ type: "READY", generation });
    } catch {
      self.postMessage({ type: "ERROR", generation, reason: stage });
    }
  }
  if (data.type === "FRAME") {
    try {
      if (!detector || data.generation !== generation) return;
      const result = detector.detectForVideo(data.bitmap, data.capture);
      self.postMessage({
        type: "RESULT",
        generation,
        capture: data.capture,
        hands: result.landmarks,
        width: data.bitmap.width,
        height: data.bitmap.height,
      });
    } catch {
      self.postMessage({ type: "ERROR", generation, reason: "MODEL_INFERENCE" });
    } finally {
      data.bitmap.close();
    }
  }
  if (data.type === "CLOSE") {
    detector?.close();
    detector = null;
    self.close();
  }
};
