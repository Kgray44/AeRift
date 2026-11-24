// Run before the app and its styles load so the first webview canvas matches the saved preference.
(() => {
  try {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
      (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
    const mobile = /Android/i.test(navigator.userAgent) ? "android" : ios ? "ios" : null;
    const scheme = mobile
      ? JSON.parse(localStorage.getItem(`aerift.${mobile}.appearance.v1`) ?? "{}")?.scheme
      : JSON.parse(localStorage.getItem("aerift.settings.v1") ?? "{}")?.appearance?.scheme;
    if (scheme === "light" || scheme === "dark") document.documentElement.dataset.startupAppearance = scheme;
  } catch {
    // Unavailable storage or an older entry leaves the OS preference in charge.
  }
})();
