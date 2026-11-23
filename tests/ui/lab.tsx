import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AppShell, Button, GlassSurface, ThemeProvider, transitionAppearance } from "../../packages/ui/src";
import { aeRiftGlassRecipe, glassAppearanceRecipes, type GlassAppearanceRecipe } from "../../packages/ui/src/GlassOptics";
import "../../packages/ui/src/styles.css";
import "./lab.css";

type Appearance = keyof typeof glassAppearanceRecipes;
type OpticalNumber = Exclude<keyof GlassAppearanceRecipe, "reflectionColor">;

const parameters: readonly { key: OpticalNumber; label: string; min: number; max: number; step: number }[] = [
  { key: "softness", label: "Backdrop softness", min: 0, max: 4, step: .1 },
  { key: "exposure", label: "Exposure", min: 80, max: 125, step: 1 },
  { key: "refraction", label: "Refraction", min: 0, max: 100, step: 1 },
  { key: "dispersion", label: "Dispersion", min: 0, max: 100, step: 1 },
  { key: "reflection", label: "Reflection intensity", min: 0, max: 100, step: 1 },
  { key: "ribbonIntensity", label: "Ribbon illumination", min: .2, max: 1.6, step: .05 },
];

function Laboratory() {
  const [appearance, setAppearance] = useState<Appearance>("dark");
  const [settings, setSettings] = useState(glassAppearanceRecipes);
  const [pattern, setPattern] = useState(false);
  const recipe = settings[appearance];
  const color = "#" + recipe.reflectionColor.map(value => value.toString(16).padStart(2, "0")).join("");
  const exportData = JSON.stringify({
    schema: "aerift-glass-lab/v1", appearance, settings: aeRiftGlassRecipe, optics: recipe,
  }, null, 2);

  function update(patch: Partial<GlassAppearanceRecipe>) {
    setSettings(current => ({ ...current, [appearance]: { ...current[appearance], ...patch } }));
  }

  return <ThemeProvider scheme={appearance}>
    <AppShell brand="GLASS Laboratory" glassRecipe={recipe}>
      <div className="ae-lab" data-experience-phase="idle">
        <div className="ae-lab-actions">
          <a href="./">Workspace showcase</a>
          <div className="ae-actions" role="group" aria-label="Preview appearance">
            {(["light", "dark"] as const).map(scheme => <Button key={scheme} variant="quiet"
              aria-pressed={scheme === appearance} onClick={() => transitionAppearance(() => setAppearance(scheme), "system")}>
              {scheme === "light" ? "Light" : "Dark"}
            </Button>)}
          </div>
          <Button variant="quiet" aria-pressed={pattern} onClick={() => setPattern(!pattern)}>High-contrast detail</Button>
        </div>
        <div className="ae-lab-stage" data-pattern={pattern}>
          <GlassSurface className={pattern ? "ae-lab-surface" : "ae-lab-surface ae-panel"} material="chrome">
            <h2>Interactive material</h2>
            <p>Reflections and refraction across text and controls.</p>
            <div className="ae-actions"><Button variant="primary">Send file</Button><Button>Choose file</Button></div>
          </GlassSurface>
          <GlassSurface material="overlay" className="ae-lab-surface">
            <h2>Floating material</h2><p>Menu and dialog surfaces.</p>
          </GlassSurface>
        </div>
        <div className="ae-lab-tuners">
          {parameters.map(({ key, label, min, max, step }) => <label key={key}>
            <span>{label} <output>{recipe[key]}</output></span>
            <input type="range" aria-label={label} min={min} max={max} step={step} value={recipe[key]}
              onChange={event => update({ [key]: event.currentTarget.valueAsNumber })} />
          </label>)}
          <label>Reflection color
            <input type="color" value={color} onChange={event => {
              const hex = event.currentTarget.value;
              update({ reflectionColor: [
                parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16),
              ] });
            }} />
          </label>
        </div>
        <div className="ae-lab-actions">
          <Button variant="quiet" onClick={() => setSettings(current => ({ ...current, [appearance]: glassAppearanceRecipes[appearance] }))}>
            Restore {appearance} defaults
          </Button>
          <a download={`aerift-glass-${appearance}.json`} href={`data:application/json,${encodeURIComponent(exportData)}`}>Download recipe</a>
        </div>
      </div>
    </AppShell>
  </ThemeProvider>;
}

createRoot(document.getElementById("root")!).render(<Laboratory />);
