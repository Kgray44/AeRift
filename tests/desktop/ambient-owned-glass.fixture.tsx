import React from "react";
import { createRoot } from "react-dom/client";
import { AmbientLiquid } from "../../apps/aerift/src/windows/AmbientLiquid";
import "../../apps/aerift/src/windows/desktop.css";

const w = 144, h = 104;
const data = new ImageData(w, h);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const index = (y * w + x) * 4;
  const checker = ((Math.floor(x / 4) + Math.floor(y / 4)) % 2) === 0;
  data.data.set(checker ? [16, 44, 155, 255] : [216, 230, 175, 255], index);
}
const root = document.getElementById("fixture")!;
const paper = document.createElement("canvas");
paper.id = "fixture-source";
paper.width = w; paper.height = h;
paper.style.cssText = "position:absolute;top:8px;left:8px;width:140px;height:101px";
paper.getContext("2d")!.putImageData(data, 0, 0);
root.appendChild(paper);
const scene = document.createElement("div");
scene.style.position = "relative";
root.appendChild(scene);
createRoot(scene).render(<AmbientLiquid reduce ownedBackplate={data} />);
