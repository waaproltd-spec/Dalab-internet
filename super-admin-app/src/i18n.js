// English/Somali for the Admin Dashboard.
//
// The dashboard's text is written in English inside App.jsx. Rather than
// rewrite thousands of strings, the Somali dictionary (i18n-so.json, keyed by
// the exact English text) is applied to what is on screen: when Somali is
// on, every text node and placeholder/title/aria-label whose trimmed text is
// a dictionary key is shown in Somali, and anything React renders later is
// translated as it appears. Switching back restores the English. Only what
// the page displays changes -- API fields, form values and data sent to the
// server are never touched (input values are not text nodes). Data that
// should never be translated can be marked translate="no".
import so from "./i18n-so.json";

const ATTRS = ["placeholder", "title", "aria-label"];
// node -> { orig, shown }: what React wrote, and the Somali we replaced it with.
const textRecords = new WeakMap();
// element -> { [attr]: { orig, shown } }
const attrRecords = new WeakMap();
let lang = "en";
let observer = null;

function translated(value) {
  const t = value.trim();
  if (!t) return null;
  const s = so[t];
  if (!s) return null;
  const start = value.indexOf(t);
  return value.slice(0, start) + s + value.slice(start + t.length);
}

function skip(el) {
  for (let e = el; e && e !== document.body; e = e.parentElement) {
    const tag = e.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEXTAREA" || tag === "CODE" || tag === "PRE") return true;
    if (e.getAttribute && e.getAttribute("translate") === "no") return true;
  }
  return false;
}

function handleText(node) {
  const rec = textRecords.get(node);
  const value = node.nodeValue;
  if (rec && value === rec.shown) {
    if (lang === "en") node.nodeValue = rec.orig;
    return;
  }
  // New node, or React changed its text since we translated it.
  if (lang !== "so") { textRecords.delete(node); return; }
  if (skip(node.parentElement)) return;
  const s = translated(value);
  if (s == null) { textRecords.delete(node); return; }
  textRecords.set(node, { orig: value, shown: s });
  node.nodeValue = s;
}

function handleAttrs(el) {
  let recs = attrRecords.get(el);
  for (const a of ATTRS) {
    if (!el.hasAttribute(a)) continue;
    const value = el.getAttribute(a);
    const rec = recs?.[a];
    if (rec && value === rec.shown) {
      if (lang === "en") el.setAttribute(a, rec.orig);
      continue;
    }
    if (lang !== "so" || skip(el)) continue;
    const s = translated(value);
    if (s == null) continue;
    if (!recs) { recs = {}; attrRecords.set(el, recs); }
    recs[a] = { orig: value, shown: s };
    el.setAttribute(a, s);
  }
}

function walk(root) {
  if (root.nodeType === Node.TEXT_NODE) { handleText(root); return; }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  handleAttrs(root);
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) handleText(n);
    else handleAttrs(n);
  }
}

function start() {
  if (observer || typeof MutationObserver === "undefined") return;
  observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "characterData") handleText(m.target);
      else if (m.type === "attributes") handleAttrs(m.target);
      else m.addedNodes.forEach(walk);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}

export function setTranslationLanguage(next) {
  lang = next === "so" ? "so" : "en";
  start();
  walk(document.body);
}

/** For strings built in code (alerts, confirms): the Somali when it's on. */
export function tr(text) {
  return lang === "so" && so[text] ? so[text] : text;
}

// Pop-ups the dashboard raises with alert()/confirm() use the same dictionary.
if (typeof window !== "undefined" && !window.__dalabDialogsTranslated) {
  window.__dalabDialogsTranslated = true;
  const alert0 = window.alert.bind(window);
  const confirm0 = window.confirm.bind(window);
  window.alert = (m) => alert0(typeof m === "string" ? tr(m) : m);
  window.confirm = (m) => confirm0(typeof m === "string" ? tr(m) : m);
}
