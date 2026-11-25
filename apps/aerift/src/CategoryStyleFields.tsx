import { GlassSurface } from "@aerift/ui";
import { categoryColors, categoryIcons, defaultCategoryStyle, type CategoryStyle } from "./category-style";
import "./category-style.css";

const paths = {
  folder: "M3 7h6l2 2h10v11H3V7Z",
  star: "m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.4-5.7-3-5.7 3 1.1-6.4L2.8 9.7l6.4-.9L12 3Z",
  heart: "M12 20 4 12a4.6 4.6 0 0 1 8-4 4.6 4.6 0 0 1 8 4l-8 8Z",
  camera: "M3 7h4l2-3h6l2 3h4v13H3V7Zm13 6a4 4 0 1 0-8 0 4 4 0 0 0 8 0Z",
  note: "M6 3h12v18H6V3Zm3 5h6m-6 4h6m-6 4h4",
  globe: "M21 12a9 9 0 1 0-18 0 9 9 0 0 0 18 0ZM3 12h18m-9-9c5 5 5 13 0 18m0-18c-5 5-5 13 0 18",
};
const title = (value: string) => value[0].toUpperCase() + value.slice(1);

export function CategoryGlyph({ appearance = defaultCategoryStyle }: { appearance?: CategoryStyle }) {
  return <svg className="aw-category-glyph" data-category-color={appearance.color} aria-hidden="true"
    viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7"
    strokeLinecap="round" strokeLinejoin="round"><path d={paths[appearance.icon]} /></svg>;
}

export function CategoryStyleFields({ appearance, onChange, disabled }: {
  appearance: CategoryStyle;
  onChange: (appearance: CategoryStyle) => void;
  disabled?: boolean;
}) {
  return <div className="aw-category-style-fields">
    <GlassSurface className="aw-category-style-options" material="raised" role="group" aria-label="Category colors">
      {categoryColors.map(color => <button key={color} type="button" disabled={disabled}
        className="aw-category-style-option" aria-label={title(color) + " color"} title={title(color) + " color"}
        aria-pressed={appearance.color === color} onClick={() => onChange({ ...appearance, color })}>
        <span className="aw-category-swatch" data-category-color={color} aria-hidden="true" />
      </button>)}
    </GlassSurface>
    <GlassSurface className="aw-category-style-options" material="raised" role="group" aria-label="Category icons">
      {categoryIcons.map(icon => <button key={icon} type="button" disabled={disabled}
        className="aw-category-style-option" aria-label={title(icon) + " icon"} title={title(icon) + " icon"}
        aria-pressed={appearance.icon === icon} onClick={() => onChange({ ...appearance, icon })}>
        <CategoryGlyph appearance={{ ...appearance, icon }} />
      </button>)}
    </GlassSurface>
  </div>;
}
