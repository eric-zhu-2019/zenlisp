// ZParen was called ZenLisp. What the web view saved under the old names moves
// to the new ones before any module reads them, so main.tsx imports this first.
for (const old of Object.keys(localStorage)) {
  if (!old.startsWith("zenlisp.")) continue;
  const key = `zparen.${old.slice("zenlisp.".length)}`;
  if (localStorage.getItem(key) === null) localStorage.setItem(key, localStorage.getItem(old)!);
  localStorage.removeItem(old);
}
