let reauthInProgress = false;

export function triggerGlobalReauth(redirectUrl) {
  if (!redirectUrl || reauthInProgress) return;
  reauthInProgress = true;

  if (typeof window !== "undefined") {
    if (window.top) {
      window.top.location.href = redirectUrl;
      return;
    }
    window.location.href = redirectUrl;
  }
}

export function isReauthInProgress() {
  return reauthInProgress;
}
