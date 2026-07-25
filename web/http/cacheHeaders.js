export function setPrivateNoStore(res) {
  res.set("Cache-Control", "no-store");
}
