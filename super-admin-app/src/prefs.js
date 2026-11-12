// Viewer preferences for the Admin Dashboard: light/dark theme and
// English/Somali. Both are saved in this browser (localStorage) and applied
// to <html> before the first render, so a refresh keeps them with no flash.
import { useSyncExternalStore } from "react";
import { setTranslationLanguage } from "./i18n.js";

const THEME_KEY = "dalab-admin-theme";
const LANG_KEY = "dalab-admin-lang";

function read(key) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function write(key, value) {
  try { window.localStorage.setItem(key, value); } catch { /* private mode: keep for this visit only */ }
}

function initialTheme() {
  const saved = read(THEME_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const state = { theme: initialTheme(), lang: read(LANG_KEY) === "so" ? "so" : "en" };
const listeners = new Set();
const emit = () => listeners.forEach((l) => l());

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", state.theme === "dark" ? "#0B1220" : "#F5F6FB");
}
function applyLang() {
  document.documentElement.lang = state.lang;
  setTranslationLanguage(state.lang);
}

export function initPrefs() {
  applyTheme();
  applyLang();
}

export function setTheme(theme) {
  state.theme = theme === "dark" ? "dark" : "light";
  write(THEME_KEY, state.theme);
  applyTheme();
  emit();
}

export function setLang(lang) {
  state.lang = lang === "so" ? "so" : "en";
  write(LANG_KEY, state.lang);
  applyLang();
  emit();
}

function subscribe(l) { listeners.add(l); return () => listeners.delete(l); }
export const useTheme = () => useSyncExternalStore(subscribe, () => state.theme);
export const useLang = () => useSyncExternalStore(subscribe, () => state.lang);
