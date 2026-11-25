export const categoryColors = ["default", "blue", "violet", "rose", "amber", "mint"] as const;
export const categoryIcons = ["folder", "star", "heart", "camera", "note", "globe"] as const;
export type CategoryStyle = { readonly color: (typeof categoryColors)[number]; readonly icon: (typeof categoryIcons)[number] };
export const defaultCategoryStyle: CategoryStyle = { color: "default", icon: "folder" };

export function decodeCategoryStyle(input: unknown): CategoryStyle | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input) ||
    Object.keys(input).length !== 2 || !("color" in input) || !("icon" in input)) return;
  const requestedColor = input.color;
  const requestedIcon = input.icon;
  const color = categoryColors.find(value => value === requestedColor);
  const icon = categoryIcons.find(value => value === requestedIcon);
  if (color && icon) return { color, icon };
}
