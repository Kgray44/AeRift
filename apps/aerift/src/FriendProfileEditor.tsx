import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Button, GlassSurface, Sheet, SpatialIcon } from "@aerift/ui";
import {
  AVATAR_COLORS, AVATAR_GLASS, PROFILE_LABEL_LIMIT, emptyPresentation, friendDisplayName,
  prepareProfilePhoto, profilePhotoBlob, type FriendPresentation, type ProfileAvatar,
} from "./friends-profile";
import "./friend-profile.css";

export type ReceivedProfileImage = { id: string; label: string };
/** The host admits only local verified receipts and exports the exact selected bounded raster. */
export type ReceivedProfileImages = {
  list(): Promise<readonly ReceivedProfileImage[]>;
  open(id: string): Promise<Blob>;
};

export function ProfileBadge({ name, avatar, size = "row" }: {
  name: string; avatar?: ProfileAvatar; size?: "row" | "detail" | "preview";
}) {
  const value = avatar ?? { kind: "initials" };
  const photo = value.kind === "photo" ? value.value : undefined;
  const [preview, setPreview] = useState<{ photo: string; url: string }>();
  useEffect(() => {
    if (!photo) return;
    const bytes = profilePhotoBlob(photo);
    if (!bytes) return;
    const url = URL.createObjectURL(bytes);
    setPreview({ photo, url });
    return () => URL.revokeObjectURL(url);
  }, [photo]);
  const url = photo && preview?.photo === photo ? preview.url : undefined;
  const initials = name.trim().split(/\s+/u).slice(0, 2).map(part => Array.from(part)[0]).join("").toLocaleUpperCase() || "?";
  return <span className="ae-profile-badge" data-size={size} data-avatar={value.kind}
    data-style={value.kind === "color" || value.kind === "glass" ? value.value : undefined} aria-hidden="true">
    {url ? <img src={url} alt="" draggable={false} /> : <span>{initials}</span>}
  </span>;
}

const tabs = [["plain", "Plain colors"], ["upload", "Upload image"], ["recent", "Recently received"],
  ["glass", "Glass styles"]] as const;
type AvatarTab = typeof tabs[number][0];
const colorNames = { violet: "Violet", blue: "Blue", mint: "Mint", coral: "Coral", gold: "Gold", slate: "Slate" };
const glassNames = { prism: "Prism", reef: "Sea glass", opal: "Opal", ember: "Ember", moon: "Moonstone", ripple: "Ripple" };

export function FriendProfileEditor({ target, open, onClose, onAfterClose, received, onSave }: {
  target: { kind: "own" | "friend"; verifiedName: string; local: FriendPresentation };
  open: boolean;
  onClose(): void;
  onAfterClose(): void;
  received?: ReceivedProfileImages;
  onSave(value: FriendPresentation): void;
}) {
  const [draft, setDraft] = useState(target.local);
  const [tab, setTab] = useState<AvatarTab>(target.local.avatar.kind === "glass" ? "glass" : target.local.avatar.kind === "photo" ? "upload" : "plain");
  const [files, setFiles] = useState<readonly ReceivedProfileImage[]>();
  const [listError, setListError] = useState(false);
  const [error, setError] = useState("");
  const [loadingPhoto, setLoadingPhoto] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const id = useId();
  const activeTabs = useRef<Partial<Record<AvatarTab, HTMLButtonElement>>>({});
  const own = target.kind === "own";
  const currentName = friendDisplayName(target.verifiedName, draft);
  useEffect(() => {
    if (!open || tab !== "recent" || !received) return;
    let stale = false;
    setFiles(undefined);
    setListError(false);
    void received.list().then(rows => {
      if (!stale) setFiles(rows.slice(0, 24));
    }, () => { if (!stale) setListError(true); });
    return () => { stale = true; };
  }, [received, tab, open]);

  async function usePhoto(load: () => Promise<Blob>) {
    if (loadingPhoto) return;
    setLoadingPhoto(true);
    setError("");
    try {
      const avatar = await prepareProfilePhoto(await load());
      setDraft(previous => ({ ...previous, avatar }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't open that image.");
    } finally { setLoadingPhoto(false); }
  }

  function arrow(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const direction = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 :
      direction === undefined ? -1 : (tabs.length + index + direction) % tabs.length;
    const name = tabs[next]?.[0];
    if (!name) return;
    event.preventDefault();
    setTab(name);
    activeTabs.current[name]?.focus();
  }

  function choose(avatar: ProfileAvatar) {
    setDraft(previous => ({ ...previous, avatar }));
    setError("");
  }

  return <Sheet open={open} title={own ? "My profile" : "Edit friend appearance"} closeIcon
    className="ae-friend-profile-sheet" onClose={onClose} onAfterClose={onAfterClose}>
    <form className="ae-profile-form" onSubmit={event => {
      event.preventDefault();
      if (loadingPhoto) return;
      try { onSave(draft); onClose(); }
      catch { setError("Couldn't save your local profile changes. Free some local storage and try again."); }
    }}>
      <div className="ae-profile-summary">
        <ProfileBadge name={currentName} avatar={draft.avatar} size="preview" />
        <div>
          <p><strong>{currentName}</strong></p>
          {own ? <small>Saved on this device. These changes aren’t shared.</small> :
            <small>Verified profile: <b>{target.verifiedName}</b>. Your edits are private to this device.</small>}
        </div>
      </div>
      <label>{own ? "Display name" : "Name on this device"}
        <input maxLength={PROFILE_LABEL_LIMIT} value={draft.localName} placeholder={target.verifiedName}
          onChange={event => setDraft(previous => ({ ...previous, localName: event.target.value }))} />
      </label>
      <label>Nickname (optional)
        <input maxLength={PROFILE_LABEL_LIMIT} value={draft.nickname} placeholder="No nickname"
          onChange={event => setDraft(previous => ({ ...previous, nickname: event.target.value }))} />
      </label>
      <div className="ae-profile-tabs" role="tablist" aria-label="Profile picture">
        {tabs.map(([name, title], index) => <Button key={name} role="tab" variant="quiet" id={id + name}
          ref={node => { if (node) activeTabs.current[name] = node; else delete activeTabs.current[name]; }}
          tabIndex={tab === name ? 0 : -1} aria-selected={tab === name} aria-controls={id + "panel"}
          onClick={() => setTab(name)} onKeyDown={event => arrow(event, index)}>{title}</Button>)}
      </div>
      <GlassSurface id={id + "panel"} className="ae-profile-picture-options" role="tabpanel" aria-labelledby={id + tab}>
        <div key={tab} className="ae-profile-tab-content" data-ae-route-enter="neutral">
          {(tab === "plain" || tab === "glass") && <div className="ae-profile-options">
            {(tab === "plain" ? AVATAR_COLORS : AVATAR_GLASS).map(name => {
              const personalAvatar = tab === "plain" ? { kind: "color", value: name as keyof typeof colorNames } as const
                : { kind: "glass", value: name as keyof typeof glassNames } as const;
              const picked = draft.avatar.kind === personalAvatar.kind && draft.avatar.value === name;
              const caption = tab === "plain" ? colorNames[name as keyof typeof colorNames] : glassNames[name as keyof typeof glassNames];
              return <Button key={name} variant="quiet" className="ae-profile-choice" aria-pressed={picked} disabled={loadingPhoto} onClick={() => choose(personalAvatar)}>
                <ProfileBadge name={currentName} avatar={personalAvatar} size="detail" />{caption}
              </Button>;
            })}
          </div>}
          {tab === "upload" && <>
            <input ref={fileInput} hidden type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
              aria-label="Choose profile image file" onChange={event => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) void usePhoto(() => Promise.resolve(file));
              }} />
            <Button disabled={loadingPhoto} onClick={() => fileInput.current?.click()}><SpatialIcon name="photo" size={16} />Choose an image</Button>
            <p>PNG, JPEG, or WebP, up to 8 MB. AeRift crops and resizes the image on this device.</p>
          </>}
          {tab === "recent" && <>
            {!received ? <p>Recently received pictures aren’t available here yet. Save one from Inbox and use Upload image.</p> :
              listError ? <p role="alert">Couldn't load recently received pictures.</p> :
              !files ? <p role="status">Loading received pictures…</p> :
              files.length ? <div className="ae-profile-options">
                {files.map(item => <Button key={item.id} variant="quiet" disabled={loadingPhoto}
                  onClick={() => void usePhoto(() => received.open(item.id))}><SpatialIcon name="photo" size={16} />{item.label}</Button>)}
              </div> : <p>No eligible pictures in Inbox.</p>}
          </>}
        </div>
      </GlassSurface>
      {loadingPhoto && <p role="status">Preparing picture…</p>}
      {error && <p role="alert">{error}</p>}
      <div className="ae-profile-actions">
        <Button variant="quiet" aria-pressed={draft.avatar.kind === "initials"} disabled={loadingPhoto}
          onClick={() => choose({ kind: "initials" })}>Use initials</Button>
        <Button variant="quiet" disabled={loadingPhoto} onClick={() => { setDraft(emptyPresentation()); setError(""); }}>Reset to default</Button>
        <Button variant="primary" disabled={loadingPhoto} type="submit">Save {own ? "profile" : "appearance"}</Button>
      </div>
    </form>
  </Sheet>;
}
