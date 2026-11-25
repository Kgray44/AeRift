import { useEffect, useId, useState, type FormEvent } from "react";
import { Button } from "@aerift/ui";
import {
  browseWorkspaceFiles, clearWorkspaceFileSearches, readWorkspaceFileSearches,
  rememberWorkspaceFileSearch, workspaceFileQueryLimit, type WorkspaceFileFilter,
  type WorkspaceFileMetadata, type WorkspaceFileOptions, type WorkspaceFileSort,
} from "./workspace-file-tools";

const initialOptions: WorkspaceFileOptions = { query: "", kind: "all", sort: "library" };

function searchStorage() {
  try { return globalThis.localStorage; } catch { return undefined; }
}

export function useWorkspaceFileTools(scope: string) {
  const [edit, setEdit] = useState({ scope, options: initialOptions });
  const [history, setHistory] = useState<{ scope: string; values: readonly string[]; error?: string }>(() => ({
    scope, values: readWorkspaceFileSearches(searchStorage(), scope),
  }));
  const options = edit.scope === scope ? edit.options : initialOptions;
  const recent = history.scope === scope ? history.values : [];

  useEffect(() => {
    setHistory({ scope, values: readWorkspaceFileSearches(searchStorage(), scope) });
  }, [scope]);

  function update(change: Partial<WorkspaceFileOptions>) {
    setEdit(previous => ({
      scope,
      options: { ...(previous.scope === scope ? previous.options : initialOptions), ...change },
    }));
  }

  function commit(query = options.query) {
    if (!query.trim()) return;
    update({ query });
    const values = rememberWorkspaceFileSearch(searchStorage(), scope, query, recent);
    setHistory({ scope, values });
  }

  function clearHistory() {
    const cleared = clearWorkspaceFileSearches(searchStorage(), scope);
    setHistory(previous => ({
      scope,
      values: cleared || previous.scope !== scope ? [] : previous.values,
      error: cleared ? undefined : "Couldn’t clear saved searches. Try again.",
    }));
  }

  return {
    ...options, recent, historyError: history.scope === scope ? history.error : undefined,
    active: options.query.trim().length > 0 || options.kind !== "all",
    setQuery: (query: string) => update({ query }),
    setKind: (kind: WorkspaceFileFilter) => update({ kind }),
    setSort: (sort: WorkspaceFileSort) => update({ sort }),
    resetFilters: () => update({ query: "", kind: "all" }),
    commit, clearHistory,
    browse<T>(entries: readonly T[], describe: (entry: T) => WorkspaceFileMetadata): T[] {
      return browseWorkspaceFiles(entries, describe, options);
    },
  };
}

type KindFilter = Exclude<WorkspaceFileFilter, "all">;
const kindsLabels: Record<KindFilter, string> = {
  document: "Documents", photo: "Images", video: "Videos", other: "Other files",
};

export function WorkspaceFileTools({ tools, label, kinds = [], dates = false }: {
  tools: ReturnType<typeof useWorkspaceFileTools>;
  label: string;
  kinds?: readonly KindFilter[];
  dates?: boolean;
}) {
  const input = useId();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    tools.commit();
  }
  return <div className="aw-file-tools">
    <form className="ae-actions" onSubmit={submit} aria-label={label}>
      <label htmlFor={input}>{label}
        <input id={input} type="search" data-ae-lens-role="control" autoComplete="off" maxLength={workspaceFileQueryLimit} value={tools.query}
          onChange={event => tools.setQuery(event.currentTarget.value)} />
      </label>
      <Button variant="quiet" type="submit" data-ae-lens-role="control" disabled={!tools.query.trim()}>Search</Button>
      {kinds.length > 0 && <label>Type
        <select data-ae-lens-role="control" value={tools.kind} onChange={event => tools.setKind(event.currentTarget.value as WorkspaceFileFilter)}>
          <option value="all">All types</option>
          {kinds.map(kind => <option key={kind} value={kind}>{kindsLabels[kind]}</option>)}
        </select>
      </label>}
      <label>Sort
        <select data-ae-lens-role="control" value={tools.sort} onChange={event => tools.setSort(event.currentTarget.value as WorkspaceFileSort)}>
          <option value="library">Library order</option>
          <option value="name">Name</option>
          {dates && <option value="newest">Most recent</option>}
          <option value="largest">Largest first</option>
          <option value="smallest">Smallest first</option>
        </select>
      </label>
      {tools.active && <Button variant="quiet" type="button" onClick={tools.resetFilters}>Reset filters</Button>}
    </form>
    {tools.recent.length > 0 && <details>
      <summary>Recent searches</summary>
      <div className="ae-actions">
        {tools.recent.map(query => <Button key={query} variant="quiet" type="button" onClick={() => tools.commit(query)}>{query}</Button>)}
        <Button variant="quiet" type="button" onClick={tools.clearHistory}>Clear recent searches</Button>
      </div>
    </details>}
    {tools.historyError && <p role="status">{tools.historyError}</p>}
  </div>;
}
