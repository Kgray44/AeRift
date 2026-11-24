import type { ModuleId } from "@aerift/app-contract/experience";

export const workspaceSections = [
  { id: "notes", module: "notes", label: "Notes", description: "Capture ideas and keep drafts close.", icon: "note", tint: "amber" },
  { id: "browser", module: "browser", label: "Web Browser", description: "Collect useful pages and open saved links.", icon: "url", tint: "blue" },
  { id: "files", module: "files", label: "File Browser", description: "Choose files and manage your local copies.", icon: "file", tint: "sky" },
  { id: "photos", module: "photos", label: "Images & Videos", description: "Preview and organize your media.", icon: "photo", tint: "violet" },
  { id: "documents", module: "files", label: "Documents", description: "Find PDFs, reports, and spreadsheets.", icon: "file", tint: "rose" },
  { id: "clipboard", module: "clipboard", label: "Clipboard", description: "Keep snippets you deliberately capture.", icon: "clipboard", tint: "mint" },
  { id: "collections", module: "collections", label: "Collections", description: "Group related objects in one place.", icon: "collection", tint: "indigo" },
] as const satisfies readonly { id: string; module: ModuleId; label: string; description: string; icon: string; tint: string }[];

export type WorkspaceSection = (typeof workspaceSections)[number];
export type WorkspaceSectionId = WorkspaceSection["id"];

const documentExtensions = /\.(pdf|docx?|odt|rtf|txt|md|pages|pptx?|key|odp|xlsx?|ods|numbers|csv|tsv|epub)$/i;
const documentMedia = /^(application\/(pdf|msword|rtf|epub\+zip|vnd\.(openxmlformats-officedocument\.[\w.]+|oasis\.opendocument\.[\w.]+|apple\.(pages|numbers|keynote)))|text\/(plain|markdown|csv|tab-separated-values))$/i;
export function isWorkspaceDocument(name: string, mediaType?: string) {
  const hasExtension = /\.[^./\\ ]{1,16}$/.test(name.trim());
  return documentExtensions.test(name.trim()) || (!hasExtension && !!mediaType && documentMedia.test(mediaType));
}
