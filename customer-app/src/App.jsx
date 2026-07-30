import React, { useState, useEffect, createContext, useContext, useMemo, useCallback } from "react";
import { Wifi, Phone, MessageSquare, Router, ChevronLeft, Home, Gift, Clock, User, Headphones, ShieldCheck, X, CheckCircle2, Loader2, Download, Hash, Settings2, Bell, MessageCircle, ThumbsUp, Share2, LogOut, ChevronRight, Pencil, Star, Info, FileText, Lock, ArrowDownUp, GraduationCap, Hand, Infinity as InfinityIcon, Sun, Moon, Monitor, Languages, HelpCircle, Smartphone, Copy, Printer, RefreshCw, XCircle, Clock3, AlertTriangle, Receipt } from "lucide-react";

// ---- Theme system ----
// Three modes: light, dark, system (follows the OS/browser preference via
// prefers-color-scheme). Persistence note: Claude artifacts explicitly
// disallow localStorage/sessionStorage, so the chosen mode lives in React
// state for this demo — it survives navigating between screens but not a
// full page reload here. In the real compiled Android/iOS app, swap the two
// no-op functions below (loadPersistedTheme/savePersistedTheme) for
// AsyncStorage (React Native) or SharedPreferences — the rest of the theme
// system doesn't change.
const THEME_PALETTES = {
  light: {
    bg: "#F4F6FB", surface: "#FFFFFF", surfaceAlt: "#F2F4FA", elevated: "#FFFFFF",
    text: "#0B1240", textMuted: "#8791B5", textSubtle: "#5B6389",
    border: "#E5E8F4", divider: "#F0F2FA", statusBarText: "#0B1240",
    inputBg: "#FFFFFF", inputBorder: "#D9DEF0", shadow: "0 30px 60px -20px rgba(20,30,90,0.35)",
  },
  dark: {
    bg: "#0B1024", surface: "#151B33", surfaceAlt: "#1B2240", elevated: "#1F2745",
    text: "#F2F4FC", textMuted: "#8791B5", textSubtle: "#B7BEDA",
    border: "#2A3358", divider: "#242C4E", statusBarText: "#F2F4FC",
    inputBg: "#1B2240", inputBorder: "#2A3358", shadow: "0 30px 60px -20px rgba(0,0,0,0.6)",
  },
};

function loadPersistedTheme() { return null; } // see comment above — no-op in this demo
function savePersistedTheme(_mode) {}           // see comment above — no-op in this demo

const ThemeContext = createContext(null);

function ThemeProvider({ children }) {
  const [mode, setModeState] = useState(() => loadPersistedTheme() || "system");
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)").matches : false
  );

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e) => setSystemPrefersDark(e.matches);
    mq.addEventListener?.("change", handler);
    return () => mq.removeEventListener?.("change", handler);
  }, []);

  const setMode = useCallback((next) => {
    setModeState(next);
    savePersistedTheme(next);
  }, []);

  const resolvedMode = mode === "system" ? (systemPrefersDark ? "dark" : "light") : mode;
  const colors = THEME_PALETTES[resolvedMode];

  const value = useMemo(() => ({ mode, resolvedMode, setMode, colors }), [mode, resolvedMode, colors]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}

// ---- Language / i18n system ----
// Same persistence note as theme: React state for this demo, AsyncStorage/
// SharedPreferences in the compiled app.
function loadPersistedLanguage() { return null; }
function savePersistedLanguage(_lang) {}

const TRANSLATIONS = {
  en: {
    // Common
    back: "Back", cancel: "Cancel", save: "Save", done: "Done", submit: "Submit",
    loading: "Loading...", retry: "Retry", close: "Close", edit: "Edit",
    // Login
    loginTagline: "Internet you can trust", loginPhoneLabel: "Enter your phone number",
    loginButton: "Login", loginPlaceholder: "61 xxx xxxx",
    // OTP
    otpTitle: "DALAB INTERNET", otpSubtitle: "CODE", otpVerifyingNumber: "Xaqiijinta lambarka",
    otpCodeIs: "Koodkaagu waa", otpEnterBelow: "Geli koodkan hoosta", otpEnterCode: "Koodka Xaqiijinta",
    otpResend: "Code cusub", otpVerify: "Verify", otpVerifying: "Verifying...",
    otpIncorrect: "Incorrect code. Check the digits above and try again.",
    otpSentBySms: "Code sent by SMS", otpEnterSms: "Enter the 4-digit code we texted you",
    // Home
    goodMorning: "Good morning", goodAfternoon: "Good afternoon", goodEvening: "Good evening",
    group1: "GROUP 1", group2: "GROUP 2", offline: "Offline", online: "Online",
    // Category
    chooseInternetType: "Dooro Nooca Internet-ka",
    // Packages
    requestInternetCode: "Request an Internet Code",
    choosePackageBelow: "Choose a package below to request your Internet Code for",
    validOnlyOn: "Each code is valid only on the", network: "network.",
    buyNow: "IIBSO", noPackagesYet: "No packages available yet for", checkBackSoon: "Check back soon.",
    // Payment
    confirmPayment: "Confirm Payment", senderNumber: "Sender number", receiverNumber: "Receiver number (Target)",
    selectPaymentMethod: "Select Payment Method", serviceDetails: "Service Details:",
    scheduleOptional: "Schedule (optional)", payNow: "PAY NOW", processing: "Processing...",
    paymentConfirmed: "Payment confirmed",
    // Receipt
    paymentSuccessful: "Payment successful", activatedOn: "activated on", receiptNo: "Receipt No.",
    date: "Date", provider: "Provider", packageLabel: "Package", totalPaid: "Total paid",
    downloadReceipt: "Download receipt",
    // Orders
    orderHistory: "Order history", noOrdersYet: "No orders yet",
    // Bottom nav
    navHome: "Home", navOrders: "Orders", navProfile: "Profile",
    // Profile
    profileTitle: "Profile", menuSetting: "Setting", menuNotifications: "Notifications",
    menuFeedback: "Share Your Feedback", menuRateApp: "Rate The App", menuInvite: "Invite Friends",
    menuDeleteAccount: "Delete Account",
    // Settings page
    settingsTitle: "Setting", settingsTheme: "Theme", settingsThemeDesc: "Choose how DALAB INTERNET looks",
    themeLight: "Light Mode", themeDark: "Dark Mode", themeSystem: "System Default",
    settingsLanguage: "Language", settingsLanguageDesc: "Choose your preferred language",
    settingsNotifications: "Notifications", settingsPrivacy: "Privacy Policy", settingsTerms: "Terms & Conditions",
    settingsContactSupport: "Contact Support", settingsAbout: "About the App", settingsAppVersion: "App Version",
    settingsLogout: "Logout", logoutConfirmTitle: "Log out?", logoutConfirmBody: "You'll need to verify your phone number again to sign back in.",
    receiveNotifOnDevice: "Receive notification on device", receiveSmsOnDevice: "Receive sms on device",
    disableNotification: "Disable notification", enableNotification: "Enable notification",
    disableSms: "Disable sms", enableSms: "Enable sms",
    aboutBody: "DALAB INTERNET lets you buy internet, calling, and SMS bundles from Hormuud, Somnet, Somtel, and Amtel in one app — with Macaash rewards on every purchase.",
    contactSupportBody: "Our support team is here every day.",
    supportCall: "Call", supportWhatsapp: "WhatsApp",
    // Notifications settings
    orderUpdates: "Order updates", orderUpdatesDesc: "Payment status and package activation",
    promotions: "Promotions & offers", promotionsDesc: "Discounts and bundle announcements",
    // Feedback
    feedbackTitle: "Feedback", selectTitle: "Select title", writeYourFeedback: "Please write your feedback",
    selectIssue: "Select Issue", thanksForFeedback: "Thanks for your feedback", teamWillReview: "Our team will review it shortly.",
    issueAppCrashes: "App crashes frequently", issuePaymentFailed: "Unable to complete payment",
    issuePaymentDeducted: "Payment failed but balance deducted", issueFeedback: "Feedback / Suggestion", issueOther: "Other",
    // Referral
    referralTitle: "Referral", inviteFriendsTitle: "Invite Your Friends",
    inviteFriendsBody: "Share DALAB INTERNET with friends and family to get the better service experience ever.",
    inviteFriendsButton: "INVITE FRIENDS",
    // Rate
    rateTitle: "Rate DALAB INTERNET", rateSubtitle: "How's your experience so far?", notNow: "Not now",
    // Delete account
    deleteConfirmTitle: "Are you sure?", deleteConfirmBody: "Are you sure you want to delete your account permanently.",
    deleteYes: "Haa", deleteNo: "Maya",
    // Support sheet
    supportTitle: "Support",
    // Order Details
    orderDetailsTitle: "Order Details", serviceName: "Service Name", orderNumber: "Order Number",
    customerPhoneLabel: "Customer Phone Number", recipientPhoneLabel: "Recipient Phone Number",
    telecomProvider: "Telecom Provider", internetPackage: "Internet Package", packagePrice: "Package Price",
    paymentMethodLabel: "Payment Method", paymentAmount: "Payment Amount", transactionIdLabel: "Transaction ID",
    orderDateTime: "Order Date & Time", paymentStatusLabel: "Payment Status", orderStatusLabel: "Order Status",
    statusPending: "Pending", statusInProgress: "In Progress", statusCompleted: "Completed",
    statusFailed: "Failed", statusCancelled: "Cancelled",
    paymentPaid: "Paid", paymentAwaiting: "Awaiting Payment",
    copyTransactionId: "Copy Transaction ID", copied: "Copied!",
    downloadReceiptPdf: "Download Receipt (PDF)", shareReceipt: "Share Receipt", refreshStatus: "Refresh Status",
    lastUpdated: "Last updated", refreshing: "Refreshing...",
    statusMsgCompleted: "Your package was delivered successfully.",
    statusMsgInProgress: "Payment confirmed — your order is being processed.",
    statusMsgPending: "Waiting for payment confirmation.",
    statusMsgFailed: "This order could not be completed.",
    statusMsgCancelled: "This order was cancelled.",
  },
  so: {
    // Common
    back: "Dib u noqo", cancel: "Jooji", save: "Kaydi", done: "Dhamaystiran", submit: "Dir",
    loading: "Waa la soo raraya...", retry: "Isku day mar kale", close: "Xir", edit: "Wax ka beddel",
    // Login
    loginTagline: "Internet aad ku kalsoon tahay", loginPhoneLabel: "Geli lambarka telefoonkaaga",
    loginButton: "Gal", loginPlaceholder: "61 xxx xxxx",
    // OTP
    otpTitle: "DALAB INTERNET", otpSubtitle: "KOODHKA", otpVerifyingNumber: "Xaqiijinta lambarka",
    otpCodeIs: "Koodkaagu waa", otpEnterBelow: "Geli koodkan hoosta", otpEnterCode: "Koodka Xaqiijinta",
    otpResend: "Koodh cusub", otpVerify: "Xaqiiji", otpVerifying: "Waa la xaqiijinayaa...",
    otpIncorrect: "Koodhku waa khalad. Fiiri lambarrada kor ku qoran oo isku day mar kale.",
    otpSentBySms: "Koodhka waa lagu diray SMS", otpEnterSms: "Geli koodhka 4-tirada ah ee aan kuu dirnay",
    // Home
    goodMorning: "Subax wanaagsan", goodAfternoon: "Galab wanaagsan", goodEvening: "Fiid wanaagsan",
    group1: "KOOXDA 1", group2: "KOOXDA 2", offline: "Offline", online: "Online",
    // Category
    chooseInternetType: "Dooro Nooca Internet-ka",
    // Packages
    requestInternetCode: "Codso Koodhka Internetka",
    choosePackageBelow: "Dooro baakad hoose si aad u codsato Koodhka Internetka ee",
    validOnlyOn: "Koodh kastaa wuxuu ku shaqeeyaa oo kaliya shabakadda", network: ".",
    buyNow: "IIBSO", noPackagesYet: "Weli lama helin baakado", checkBackSoon: "Fadlan dib u soo eeg.",
    // Payment
    confirmPayment: "Xaqiiji Lacag-bixinta", senderNumber: "Lambarka diraya", receiverNumber: "Lambarka helaya (Bartilmaameedka)",
    selectPaymentMethod: "Dooro Habka Lacag-bixinta", serviceDetails: "Faahfaahinta Adeegga:",
    scheduleOptional: "Jadwal (ikhtiyaari)", payNow: "BIXI HADDA", processing: "Waa la socodsiinayaa...",
    paymentConfirmed: "Lacag-bixintu waa la xaqiijiyay",
    // Receipt
    paymentSuccessful: "Lacag-bixintu way guulaysatay", activatedOn: "waxaa lagu shaqaysiiyay",
    receiptNo: "Lambarka Rasiidhka", date: "Taariikhda", provider: "Adeeg-bixiye", packageLabel: "Baakad",
    totalPaid: "Wadarta la bixiyay", downloadReceipt: "Soo deji rasiidhka",
    // Orders
    orderHistory: "Taariikhda Dalabyada", noOrdersYet: "Wali dalab ma jiro",
    // Bottom nav
    navHome: "Guriga", navOrders: "Dalabyada", navProfile: "Xisaabta",
    // Profile
    profileTitle: "Xisaabta", menuSetting: "Dejinta", menuNotifications: "Ogeysiisyada",
    menuFeedback: "La Wadaag Fikradaada", menuRateApp: "Qiimee App-ka", menuInvite: "Ku Casuumo Saaxiibada",
    menuDeleteAccount: "Tirtir Xisaabta",
    // Settings page
    settingsTitle: "Dejinta", settingsTheme: "Muuqaalka", settingsThemeDesc: "Dooro sida DALAB INTERNET u ekaan doonto",
    themeLight: "Muuqaal Iftiin ah", themeDark: "Muuqaal Madow", themeSystem: "Kan Nidaamka",
    settingsLanguage: "Luqadda", settingsLanguageDesc: "Dooro luqadda aad doorbidayso",
    settingsNotifications: "Ogeysiisyada", settingsPrivacy: "Siyaasadda Sirta", settingsTerms: "Shuruudaha & Xaaladaha",
    settingsContactSupport: "La Xiriir Taageerada", settingsAbout: "Ku Saabsan App-ka", settingsAppVersion: "Nooca App-ka",
    settingsLogout: "Ka Bax", logoutConfirmTitle: "Ma rabtaa inaad ka baxdo?",
    logoutConfirmBody: "Waxaad u baahan doontaa inaad mar kale xaqiijiso lambarkaaga si aad dib ugu gasho.",
    receiveNotifOnDevice: "Hel ogeysiis qalabkaaga", receiveSmsOnDevice: "Hel SMS qalabkaaga",
    disableNotification: "Damiin ogeysiiska", enableNotification: "Shid ogeysiiska",
    disableSms: "Damiin SMS-ka", enableSms: "Shid SMS-ka",
    aboutBody: "DALAB INTERNET wuxuu kuu ogolaanayaa inaad ka iibsato internet, wac, iyo SMS Hormuud, Somnet, Somtel, iyo Amtel hal app — leh abaalmarinta Macaash iibsi kasta.",
    contactSupportBody: "Kooxdeenna taageerada waa halkan maalin kasta.",
    supportCall: "Wac", supportWhatsapp: "WhatsApp",
    // Notifications settings
    orderUpdates: "Cusbooneysiinta Dalabka", orderUpdatesDesc: "Xaaladda lacag-bixinta iyo hawlgelinta baakadda",
    promotions: "Dallacsiinta & Dhoofinta", promotionsDesc: "Qiimo-dhimis iyo ogeysiisyada baakadaha",
    // Feedback
    feedbackTitle: "Fikradaha", selectTitle: "Dooro cinwaanka", writeYourFeedback: "Fadlan qor fikradaada",
    selectIssue: "Dooro Dhibaatada", thanksForFeedback: "Waad ku mahadsan tahay fikradaada", teamWillReview: "Kooxdeenu way dib u eegi doontaa.",
    issueAppCrashes: "App-ku si joogto ah ayuu u xiraa", issuePaymentFailed: "Lacag-bixinta lama dhamaystirin",
    issuePaymentDeducted: "Lacag-bixintu way fashilantay balse lacagta waa laga jaray", issueFeedback: "Fikrad / Soo jeedin", issueOther: "Kale",
    // Referral
    referralTitle: "U-xilsaarid", inviteFriendsTitle: "Ku Casuumo Saaxiibadaada",
    inviteFriendsBody: "La wadaag DALAB INTERNET saaxiibada iyo qoyska si ay u helaan adeeg wanaagsan.",
    inviteFriendsButton: "KU CASUUMO SAAXIIBADA",
    // Rate
    rateTitle: "Qiimee DALAB INTERNET", rateSubtitle: "Sideed u aragtaa adeeggeena ilaa hadda?", notNow: "Hadda ha ahaan",
    // Delete account
    deleteConfirmTitle: "Ma hubtaa?", deleteConfirmBody: "Ma hubtaa inaad rabto inaad si joogto ah u tirtirto xisaabtaada.",
    deleteYes: "Haa", deleteNo: "Maya",
    // Support sheet
    supportTitle: "Taageero",
    // Order Details
    orderDetailsTitle: "Faahfaahinta Dalabka", serviceName: "Magaca Adeegga", orderNumber: "Lambarka Dalabka",
    customerPhoneLabel: "Lambarka Macmiilka", recipientPhoneLabel: "Lambarka Helaya",
    telecomProvider: "Adeeg-bixiyaha", internetPackage: "Baakadda Internetka", packagePrice: "Qiimaha Baakadda",
    paymentMethodLabel: "Habka Lacag-bixinta", paymentAmount: "Lacagta la Bixiyay", transactionIdLabel: "Lambarka Dhaqdhaqaaqa",
    orderDateTime: "Taariikhda & Waqtiga Dalabka", paymentStatusLabel: "Xaaladda Lacag-bixinta", orderStatusLabel: "Xaaladda Dalabka",
    statusPending: "Sugaya", statusInProgress: "Socda", statusCompleted: "Dhamaystiran",
    statusFailed: "Fashilmay", statusCancelled: "La Joojiyay",
    paymentPaid: "La Bixiyay", paymentAwaiting: "Sugaya Lacag-bixinta",
    copyTransactionId: "Koobi Lambarka Dhaqdhaqaaqa", copied: "Waa la koobiyeeyay!",
    downloadReceiptPdf: "Soo Deji Rasiidhka (PDF)", shareReceipt: "La Wadaag Rasiidhka", refreshStatus: "Cusbooneysii Xaaladda",
    lastUpdated: "Markii ugu dambeysay ee la cusbooneysiiyay", refreshing: "Waa la cusbooneysiinayaa...",
    statusMsgCompleted: "Baakaddaadu si guul leh ayaa loo geeyay.",
    statusMsgInProgress: "Lacag-bixinta waa la xaqiijiyay — dalabkaaga waa la socodsiinayaa.",
    statusMsgPending: "Waxaan sugeynaa xaqiijinta lacag-bixinta.",
    statusMsgFailed: "Dalabkan lama dhamaystiri karin.",
    statusMsgCancelled: "Dalabkan waa la joojiyay.",
  },
};

const LANGUAGES = [
  { code: "en", label: "English", flag: "🇬🇧" },
  { code: "so", label: "Somali", flag: "🇸🇴" },
];

const I18nContext = createContext(null);

function I18nProvider({ children }) {
  const [lang, setLangState] = useState(() => loadPersistedLanguage() || "en");

  const setLang = useCallback((next) => {
    setLangState(next);
    savePersistedLanguage(next);
  }, []);

  const t = useCallback((key) => TRANSLATIONS[lang]?.[key] ?? TRANSLATIONS.en[key] ?? key, [lang]);

  const value = useMemo(() => ({ lang, setLang, t, languages: LANGUAGES }), [lang, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}

// ---- Design tokens ----
// Primary: Dalab Indigo #1D2E8C  Accent: Dalab Green #22B24C
// Kept close to the existing brand equity (blue triangle mark, green signal),
// since the brief is a rebrand, not a new identity.

// ---- API client ----
// Set this to a deployed backend's URL (see dalab-backend.zip) to switch this
// app from demo/mock data to the real API. Left empty, every screen below
// keeps working exactly as it does now, seeded from the PROVIDERS/PACKAGES/
// BANNERS constants — nothing breaks if this stays unset. Once set, the order
// flow (see App's onBuy handler) calls the real backend instead of only
// updating local state.
const DALAB_API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "";
const DALAB_API_ENABLED = Boolean(DALAB_API_BASE_URL);

let dalabAccessToken = null;

async function dalabApiRequest(path, { method = "GET", body, auth = false } = {}) {
  if (!DALAB_API_ENABLED) throw new Error("DALAB API not configured (DALAB_API_BASE_URL is empty)");
  const headers = { "Content-Type": "application/json" };
  if (auth && dalabAccessToken) headers.Authorization = `Bearer ${dalabAccessToken}`;
  const res = await fetch(`${DALAB_API_BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
  return json;
}

// One function per real endpoint this app needs — matches dalab-backend.zip's
// src/routes/*.js exactly (see dalab-backend-architecture.md §4 for the full
// contract). Every one of these is real, working code, not a stub; it's just
// unreachable until DALAB_API_BASE_URL points at a deployed server.
const DalabApi = {
  requestOtp: (phone) => dalabApiRequest("/auth/otp/request", { method: "POST", body: { phone } }),
  verifyOtp: (phone, code) => dalabApiRequest("/auth/otp/verify", { method: "POST", body: { phone, code } }),
  getCompanies: () => dalabApiRequest("/companies"),
  getPackages: (companyId) => dalabApiRequest(`/companies/${companyId}/packages`),
  getBanners: () => dalabApiRequest("/banners"),
  createOrder: (companyId, packageId, receiverPhone, paymentMethod) =>
    dalabApiRequest("/orders", { method: "POST", auth: true, body: { companyId, packageId, receiverPhone, paymentMethod } }),
  getOrders: () => dalabApiRequest("/orders", { auth: true }),
  getOrder: (orderId) => dalabApiRequest(`/orders/${orderId}`, { auth: true }),
  getMacaashBalance: () => dalabApiRequest("/macaash/balance", { auth: true }),
  getMacaashRewards: () => dalabApiRequest("/macaash/rewards", { auth: true }),
  redeemMacaash: (rewardId) => dalabApiRequest("/macaash/redeem", { method: "POST", auth: true, body: { rewardId } }),
  getMacaashHistory: () => dalabApiRequest("/macaash/history", { auth: true }),
};

const PROVIDERS = [
  { id: "hormuud", name: "Hormuud", color: "#16A34A", group: 1, ussd: "*770#", payNumber: "252-61-XXXXXXX (EVC Plus)", status: "online" },
  { id: "somnet", name: "Somnet", color: "#1D4ED8", group: 1, ussd: "*828#", payNumber: "252-65-XXXXXXX (Jeeb)", status: "online" },
  { id: "somtel", name: "Somtel", color: "#F2C200", group: 2, ussd: "*883#", payNumber: "252-63-XXXXXXX (eDahab)", status: "online" },
  { id: "amtel", name: "Amtel", color: "#C81E2C", group: 2, ussd: "*505#", payNumber: "252-68-XXXXXXX", status: "offline" },
];

const CATEGORIES = {
  hormuud: [
    { id: "anfac", label: "Anfac", icon: Phone },
    { id: "anfac-plus", label: "Anfac Plus", icon: ArrowDownUp },
    { id: "unlimited-data-voice", label: "Unlimited Data & Voice", icon: ArrowDownUp },
    { id: "unlimited-calls", label: "Unlimited Calls", icon: Phone },
    { id: "5g-plus", label: "5G Plus", icon: Router },
    { id: "adsl-arday", label: "ADSL Arday", icon: GraduationCap },
    { id: "kaar-kuhadal", label: "Kaar Kuhadal", icon: Hand },
    { id: "adsl-plus", label: "ADSL Plus", icon: Router },
  ],
  somnet: [
    { id: "qanciye-plus", label: "Qanciye Plus", icon: ArrowDownUp },
    { id: "unlimited-data-voice", label: "Unlimited Data & Voice", icon: ArrowDownUp },
    { id: "unlimited-data", label: "Unlimited Data", icon: ArrowDownUp },
    { id: "unlimited-voice", label: "Unlimited Voice", icon: Phone },
    { id: "mifi", label: "Mifi Internet (GB)", icon: Router },
    { id: "5g", label: "5G", icon: Router },
  ],
  somtel: [
    { id: "unlimited-data-voice", label: "Unlimited Data & Voice", icon: ArrowDownUp },
    { id: "no-expire", label: "No Expire", icon: InfinityIcon },
    { id: "unlimited-calls", label: "Unlimited Calls", icon: Phone },
    { id: "voice", label: "Voice", icon: Phone },
  ],
  amtel: [
    { id: "unlimited-data-voice", label: "Unlimited Data & Voice", icon: ArrowDownUp },
    { id: "no-expire", label: "No Expire", icon: InfinityIcon },
  ],
};

// Packages keyed by [providerId][categoryId]. Categories without confirmed
// pricing yet show an empty state in the UI rather than invented numbers.
const PACKAGES = {
  hormuud: {
    anfac: [
      { id: "hor-an-1", name: "Anfac Kuhadal", old: 0.1, price: 0.09, desc: "8 daqiiqo kuhadal, 0 SMS, 30 maalin" },
      { id: "hor-an-2", name: "Anfac Kuhadal", old: 0.5, price: 0.45, desc: "40 daqiiqo kuhadal, 0 SMS, 30 maalin" },
      { id: "hor-an-3", name: "Anfac Kuhadal", old: 1, price: 0.88, desc: "80 daqiiqo kuhadal, 0 SMS, 30 maalin" },
    ],
    "anfac-plus": [
      { id: "hor-ap-1", name: "Anfac Plus", old: 0.25, price: 0.22, desc: "400 MB, 10 min free calls, valid 1 day" },
      { id: "hor-ap-2", name: "Anfac Plus", old: 0.5, price: 0.45, desc: "850 MB, 30 min free calls, valid 10 days" },
      { id: "hor-ap-3", name: "Anfac Plus", old: 1, price: 0.89, desc: "2 GB, 80 min, 50 SMS, valid 2 weeks" },
      { id: "hor-ap-4", name: "Anfac Plus", old: 2, price: 1.78, desc: "5 GB, 160 min, 100 SMS, valid 1 month" },
    ],
  },
  somnet: {
    "qanciye-plus": [
      { id: "som-qp-1", name: "Qanciye Plus 170MB", old: 0.1, price: 0.09, desc: "170 MB, 5 daqiiqo kuhadal, 0 SMS, no expire" },
      { id: "som-qp-2", name: "Qanciye Plus 425MB", old: 0.25, price: 0.23, desc: "425 MB, 11 daqiiqo kuhadal, 10 SMS, no expire" },
      { id: "som-qp-3", name: "Qanciye Plus 1.2GB", old: 0.5, price: 0.45, desc: "1.2 GB, 35 daqiiqo kuhadal, 25 SMS, no expire" },
      { id: "som-qp-4", name: "Qanciye Plus 2.5GB", old: 1, price: 0.89, desc: "2.5 GB, no expire" },
    ],
  },
  somtel: {
    "unlimited-data-voice": [
      { id: "stl-ud-1", name: "Unlimited Data & Voice", old: 0.2, price: 0.18, desc: "Unlimited internet, Nashaad App, 6 saac" },
      { id: "stl-ud-2", name: "Unlimited Data & Voice", old: 0.35, price: 0.31, desc: "Unlimited internet, Nashaad App, 12 saac" },
      { id: "stl-ud-3", name: "Unlimited Data & Voice", old: 0.5, price: 0.45, desc: "Unlimited internet, Nashaad App, 24 saac" },
    ],
  },
  amtel: {
    "unlimited-data-voice": [
      { id: "amt-ud-1", name: "Unlimited Data & Voice", old: 0.25, price: 0.23, desc: "Unlimited internet & kuhadal, IP TV & SMS, 10 saac" },
      { id: "amt-ud-2", name: "Unlimited Data & Voice", old: 0.5, price: 0.45, desc: "Unlimited internet & kuhadal, IP TV & SMS, 36 saac" },
      { id: "amt-ud-3", name: "Unlimited Data & Voice", old: 1, price: 0.88, desc: "Unlimited internet & kuhadal, IP TV & SMS, 3 maalin" },
    ],
  },
};

const LOGOS = {
  hormuud: "data:image/jpeg;base64,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",
  somnet: "data:image/jpeg;base64,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",
  somtel: "data:image/jpeg;base64,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",
  amtel: "data:image/jpeg;base64,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",
};

const BANNERS = [
  {
    id: "bnr-2",
    title: "Weekend Data Bonus",
    subtitle: "Get 20% extra MB on Anfac Plus, Fri–Sun",
    gradient: "linear-gradient(135deg,#1D2E8C,#2A3FC0)",
  },
];

const PAYMENT_METHODS = [
  { id: "evc", label: "EVC Plus", color: "#16A34A", useLogo: "hormuud" },
  { id: "edahab", label: "EDahab", color: "#F2C200", useLogo: "somtel" },
  { id: "jeeb", label: "Jeeb", color: "#1D4ED8", useLogo: "somnet" },
];

function genReference() {
  return "DLB" + Math.floor(100000000 + Math.random() * 900000000);
}

function Logo({ size = 96 }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.28,
        background: "linear-gradient(160deg,#2436A8,#16209E)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: "0 12px 30px -8px rgba(29,46,140,0.55)",
      }}
    >
      <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 100 100">
        <polygon points="50,10 15,85 85,85" fill="#fff" />
        <polygon points="50,10 60,32 42,32" fill="#22B24C" />
        <circle cx="60" cy="60" r="8" fill="#22B24C" />
        <path d="M60 60 Q75 50 78 32" stroke="#fff" strokeWidth="7" fill="none" strokeLinecap="round" />
        <path d="M60 60 Q80 55 90 45" stroke="#fff" strokeWidth="7" fill="none" strokeLinecap="round" />
        <polygon points="70,68 90,60 84,82" fill="#22B24C" />
      </svg>
    </div>
  );
}

function Screen({ children }) {
  const { colors } = useTheme();
  return (
    <div
      style={{
        width: 375,
        height: 780,
        background: colors.bg,
        borderRadius: 40,
        overflow: "hidden",
        position: "relative",
        boxShadow: colors.shadow,
        fontFamily:
          "'Inter','Segoe UI',system-ui,-apple-system,sans-serif",
        display: "flex",
        flexDirection: "column",
        color: colors.text,
      }}
    >
      {children}
    </div>
  );
}

function StatusBar() {
  const { colors } = useTheme();
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 22px 0", fontSize: 12, color: colors.statusBarText, fontWeight: 600 }}>
      <span>19:51</span>
      <span>DALAB • 4G+</span>
    </div>
  );
}

function BottomNav({ active, onNav }) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const items = [
    { id: "home", label: t("navHome"), icon: Home },
    { id: "orders", label: t("navOrders"), icon: Clock },
    { id: "profile", label: t("navProfile"), icon: User },
  ];
  return (
    <div style={{ display: "flex", justifyContent: "space-around", padding: "10px 6px 18px", background: colors.surface, borderTop: `1px solid ${colors.border}` }}>
      {items.map((it) => {
        const Icon = it.icon;
        const isActive = active === it.id;
        return (
          <button
            key={it.id}
            onClick={() => onNav(it.id)}
            style={{
              background: "none",
              border: "none",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
              color: isActive ? "#1D2E8C" : colors.textMuted,
              cursor: "pointer",
            }}
          >
            <Icon size={20} strokeWidth={isActive ? 2.6 : 2} />
            <span style={{ fontSize: 11, fontWeight: isActive ? 700 : 500 }}>{it.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function SupportButton({ onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        position: "absolute",
        right: 18,
        bottom: 92,
        width: 52,
        height: 52,
        borderRadius: 26,
        background: "#0B1240",
        border: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: "0 10px 24px -6px rgba(11,18,64,0.5)",
        cursor: "pointer",
      }}
    >
      <Headphones size={22} color="#22B24C" />
    </button>
  );
}

// ---- Screens ----

function SplashLogin({ onLogin }) {
  const [phone, setPhone] = useState("");
  const { colors } = useTheme();
  const { t } = useI18n();
  return (
    <Screen>
      <StatusBar />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", padding: "36px 28px 0" }}>
        <Logo />
        <div style={{ marginTop: 18, fontSize: 26, fontWeight: 800, color: colors.text, letterSpacing: 1 }}>DALAB INTERNET</div>
        <div style={{ fontSize: 11, letterSpacing: 3, color: "#1D2E8C", fontWeight: 700, marginTop: 2 }}>{t("loginTagline").toUpperCase()}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "22px 0", color: colors.textMuted, fontSize: 13 }}>
          <div style={{ width: 44, height: 1, background: colors.border }} />
          {t("loginTagline")}
          <div style={{ width: 44, height: 1, background: colors.border }} />
        </div>
        <div style={{ width: "100%", background: colors.surface, borderRadius: 20, padding: 20, boxShadow: "0 2px 14px rgba(20,30,90,0.06)" }}>
          <div style={{ fontSize: 14, color: colors.textSubtle, marginBottom: 10 }}>{t("loginPhoneLabel")}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ background: colors.surfaceAlt, borderRadius: 14, padding: "12px 12px", fontWeight: 700, color: "#1D2E8C" }}>+252</div>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
              placeholder={t("loginPlaceholder")}
              style={{ flex: 1, border: `1px solid ${colors.inputBorder}`, background: colors.inputBg, borderRadius: 14, padding: "12px 12px", fontSize: 15, outline: "none", color: colors.text }}
            />
          </div>
          <button
            onClick={() => phone.length >= 6 && onLogin(phone)}
            style={{
              marginTop: 16,
              width: "100%",
              padding: "14px 0",
              borderRadius: 14,
              border: "none",
              background: phone.length >= 6 ? "linear-gradient(90deg,#1D2E8C,#2A3FC0)" : "#C6CCE6",
              color: "#fff",
              fontWeight: 700,
              fontSize: 15,
              cursor: phone.length >= 6 ? "pointer" : "not-allowed",
            }}
          >
            {t("loginButton")}
          </button>
        </div>
      </div>
    </Screen>
  );
}

function OtpScreen({ phone, onVerified, onBack }) {
  const [generated, setGenerated] = useState(() => String(Math.floor(1000 + Math.random() * 9000)));
  const [code, setCode] = useState(["", "", "", ""]);
  const [error, setError] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const full = code.join("").length === 4;
  const { colors } = useTheme();
  const { t } = useI18n();

  // Live mode requests a real SMS OTP on mount instead of generating one
  // client-side. Demo mode (default, DALAB_API_ENABLED = false) is completely
  // unaffected — this effect is a no-op unless a real API URL is configured.
  useEffect(() => {
    if (DALAB_API_ENABLED) {
      DalabApi.requestOtp(phone).catch(() => setError(true));
    }
  }, [phone]);

  const setDigit = (i, v) => {
    if (!/^\d?$/.test(v)) return;
    const next = [...code];
    next[i] = v;
    setCode(next);
    setError(false);
  };

  const resend = () => {
    if (DALAB_API_ENABLED) {
      DalabApi.requestOtp(phone).catch(() => setError(true));
      setCode(["", "", "", ""]);
      setError(false);
      return;
    }
    setGenerated(String(Math.floor(1000 + Math.random() * 9000)));
    setCode(["", "", "", ""]);
    setError(false);
  };

  const verify = async () => {
    if (!full || verifying) return;
    if (DALAB_API_ENABLED) {
      setVerifying(true);
      try {
        const result = await DalabApi.verifyOtp(phone, code.join(""));
        dalabAccessToken = result.accessToken;
        onVerified();
      } catch {
        setError(true);
      } finally {
        setVerifying(false);
      }
      return;
    }
    if (code.join("") === generated) {
      onVerified();
    } else {
      setError(true);
    }
  };

  return (
    <Screen>
      <StatusBar />
      <div style={{ display: "flex", alignItems: "center", padding: "14px 18px 0", gap: 10 }}>
        <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer" }}>
          <ChevronLeft color={colors.text} />
        </button>
        <span style={{ fontWeight: 700, color: colors.text, fontSize: 15 }}>{t("otpVerifyingNumber")}</span>
      </div>
      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", alignItems: "center", padding: "20px 26px 0" }}>
        <Logo size={84} />
        <div style={{ marginTop: 14, fontSize: 24, fontWeight: 800, color: colors.text, letterSpacing: 0.5 }}>{t("otpTitle")}</div>
        <div style={{ fontSize: 11, letterSpacing: 3, color: "#1D2E8C", fontWeight: 700, marginTop: 2 }}>{t("otpSubtitle")}</div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "16px 0 4px", color: colors.textMuted, fontSize: 12.5 }}>
          <div style={{ width: 36, height: 1, background: colors.border }} />
          {t("loginTagline")}
          <div style={{ width: 36, height: 1, background: colors.border }} />
        </div>

        <div style={{ fontSize: 13, color: colors.textSubtle, marginTop: 10 }}>{t("otpVerifyingNumber")} +252 {phone}</div>

        {DALAB_API_ENABLED ? (
          <div style={{ width: "100%", background: colors.surfaceAlt, borderRadius: 18, padding: 20, marginTop: 16, textAlign: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#1D2E8C", fontWeight: 700, fontSize: 14, justifyContent: "center" }}>
              <ShieldCheck size={18} /> {t("otpSentBySms")}
            </div>
            <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 8 }}>{t("otpEnterSms")}</div>
          </div>
        ) : (
          <div style={{ width: "100%", background: colors.surfaceAlt, borderRadius: 18, padding: 20, marginTop: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#1D2E8C", fontWeight: 700, fontSize: 14, justifyContent: "center" }}>
              <ShieldCheck size={18} /> {t("otpCodeIs")}
            </div>
            <div style={{ display: "flex", gap: 12, justifyContent: "center", marginTop: 16 }}>
              {generated.split("").map((d, i) => (
                <div
                  key={i}
                  style={{
                    width: 46, height: 54, borderRadius: 12, background: colors.elevated,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 24, fontWeight: 800, color: "#1D2E8C",
                  }}
                >
                  {d}
                </div>
              ))}
            </div>
            <div style={{ textAlign: "center", fontSize: 11.5, color: colors.textMuted, marginTop: 10 }}>{t("otpEnterBelow")}</div>
          </div>
        )}

        <div style={{ width: "100%", marginTop: 20 }}>
          <div style={{ fontSize: 13.5, color: colors.textSubtle, fontWeight: 600 }}>{t("otpEnterCode")}</div>
          <div style={{ display: "flex", gap: 12, marginTop: 10 }}>
            {code.map((c, i) => (
              <input
                key={i}
                value={c}
                onChange={(e) => setDigit(i, e.target.value)}
                maxLength={1}
                style={{
                  width: 46,
                  height: 54,
                  textAlign: "center",
                  fontSize: 22,
                  fontWeight: 700,
                  color: colors.text,
                  borderRadius: 12,
                  border: error ? "1px solid #C81E2C" : `1px solid ${colors.inputBorder}`,
                  background: colors.inputBg,
                  outline: "none",
                }}
              />
            ))}
          </div>
          {error && <div style={{ color: "#C81E2C", fontSize: 12, marginTop: 8, fontWeight: 600 }}>{t("otpIncorrect")}</div>}
        </div>

        <div style={{ width: "100%", display: "flex", justifyContent: "flex-end" }}>
          <button onClick={resend} style={{ background: "none", border: "none", color: "#1D2E8C", fontWeight: 600, fontSize: 13, marginTop: 14, cursor: "pointer" }}>
            {t("otpResend")}
          </button>
        </div>

        <button
          onClick={verify}
          disabled={verifying}
          style={{
            marginTop: 20,
            marginBottom: 20,
            width: "100%",
            padding: "14px 0",
            borderRadius: 14,
            border: "none",
            background: full && !verifying ? "linear-gradient(90deg,#1D2E8C,#2A3FC0)" : "#C6CCE6",
            color: "#fff",
            fontWeight: 700,
            fontSize: 15,
            cursor: full && !verifying ? "pointer" : "not-allowed",
          }}
        >
          {verifying ? t("otpVerifying") : t("otpVerify")}
        </button>
      </div>
    </Screen>
  );
}

function HomeScreen({ onSelectProvider, onNav, onSupport }) {
  const group1 = PROVIDERS.filter((p) => p.group === 1);
  const group2 = PROVIDERS.filter((p) => p.group === 2);
  const [bannerIdx, setBannerIdx] = useState(0);
  const banner = BANNERS[bannerIdx];
  const { colors } = useTheme();
  const { t } = useI18n();

  const hour = new Date().getHours();
  const greeting = hour < 12 ? t("goodMorning") : hour < 18 ? t("goodAfternoon") : t("goodEvening");

  return (
    <Screen>
      <StatusBar />
      <div style={{ padding: "16px 20px 0", flex: 1, overflowY: "auto" }}>
        <div style={{ fontSize: 13, color: colors.textMuted }}>{greeting}</div>
        <div style={{ fontSize: 22, fontWeight: 800, color: colors.text }}>Yaaain</div>

        <div
          onClick={() => BANNERS.length > 1 && setBannerIdx((bannerIdx + 1) % BANNERS.length)}
          style={{
            marginTop: 16,
            borderRadius: 20,
            padding: 22,
            background: banner.gradient,
            color: "#fff",
            cursor: BANNERS.length > 1 ? "pointer" : "default",
            transition: "background .25s",
          }}
        >
          <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "Georgia, serif" }}>{banner.title}</div>
          <div style={{ fontSize: 13, opacity: 0.9, marginTop: 4 }}>{banner.subtitle}</div>
        </div>

        {BANNERS.length > 1 && (
          <div style={{ display: "flex", justifyContent: "center", gap: 6, marginTop: 10 }}>
            {BANNERS.map((b, i) => (
              <button
                key={b.id}
                onClick={() => setBannerIdx(i)}
                style={{
                  width: i === bannerIdx ? 16 : 6,
                  height: 6,
                  borderRadius: 3,
                  border: "none",
                  background: i === bannerIdx ? "#1D2E8C" : colors.border,
                  cursor: "pointer",
                  transition: "width .2s",
                  padding: 0,
                }}
              />
            ))}
          </div>
        )}

        <div style={{ marginTop: 20, fontSize: 12, fontWeight: 700, color: colors.textMuted, letterSpacing: 1 }}>{t("group1")}</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 8 }}>
          {group1.map((p) => (
            <ProviderCard key={p.id} p={p} onClick={() => onSelectProvider(p.id)} />
          ))}
        </div>

        <div style={{ marginTop: 18, fontSize: 12, fontWeight: 700, color: colors.textMuted, letterSpacing: 1 }}>{t("group2")}</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 8, marginBottom: 12 }}>
          {group2.map((p) => (
            <ProviderCard key={p.id} p={p} onClick={() => onSelectProvider(p.id)} />
          ))}
        </div>
      </div>
      <SupportButton onClick={onSupport} />
      <BottomNav active="home" onNav={onNav} />
    </Screen>
  );
}

function ProviderCard({ p, onClick }) {
  const offline = p.status === "offline";
  const { colors } = useTheme();
  const { t } = useI18n();
  return (
    <button
      onClick={() => !offline && onClick()}
      style={{
        border: "none",
        cursor: offline ? "not-allowed" : "pointer",
        borderRadius: 16,
        overflow: "hidden",
        background: colors.surface,
        boxShadow: "0 2px 10px rgba(20,30,90,0.06)",
        padding: 0,
        textAlign: "left",
        position: "relative",
        opacity: offline ? 0.75 : 1,
      }}
    >
      <div style={{ background: p.color, height: 74, display: "flex", alignItems: "center", justifyContent: "center", padding: 12, filter: offline ? "grayscale(1)" : "none" }}>
        {LOGOS[p.id] ? (
          <img src={LOGOS[p.id]} alt={p?.name || "Provider"} style={{ maxHeight: "100%", maxWidth: "100%", objectFit: "contain" }} />
        ) : (
          <Wifi color="#fff" size={30} />
        )}
      </div>
      <div style={{ padding: "10px 12px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontWeight: 700, color: colors.text, fontSize: 14 }}>{p?.name || "Unknown provider"}</span>
        {offline ? (
          <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10.5, fontWeight: 700, color: "#C81E2C" }}>
            <span style={{ width: 6, height: 6, borderRadius: 3, background: "#C81E2C" }} />
            {t("offline")}
          </span>
        ) : (
          <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10.5, fontWeight: 700, color: "#16A34A" }}>
            <span style={{ width: 6, height: 6, borderRadius: 3, background: "#16A34A" }} />
            {t("online")}
          </span>
        )}
      </div>
    </button>
  );
}

function CategoryScreen({ providerId, onBack, onSelectCategory }) {
  const provider = PROVIDERS.find((p) => p.id === providerId);
  const categories = CATEGORIES[providerId] || [];
  const { colors } = useTheme();
  const { t } = useI18n();
  return (
    <Screen>
      <StatusBar />
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 18px 0" }}>
        <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer" }}>
          <ChevronLeft color={colors.text} />
        </button>
        <span style={{ fontWeight: 700, color: colors.text, fontSize: 17 }}>{provider?.name || "Unknown provider"}</span>
      </div>
      <div style={{ padding: "14px 20px 4px", fontSize: 19, fontWeight: 800, color: colors.text }}>{t("chooseInternetType")}</div>
      <div style={{ flex: 1, overflowY: "auto", padding: "10px 20px 20px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          {categories.map((cat) => {
            const Icon = cat.icon;
            const hasPackages = Boolean(PACKAGES[providerId]?.[cat.id]?.length);
            return (
              <button
                key={cat.id}
                onClick={() => onSelectCategory(cat.id)}
                style={{
                  border: `1.5px solid ${provider.color}55`,
                  borderRadius: 16,
                  background: colors.surface,
                  padding: "16px 8px",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 10,
                  cursor: "pointer",
                  position: "relative",
                }}
              >
                <div style={{ width: 48, height: 48, borderRadius: 12, background: provider.color, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <Icon size={22} color="#fff" />
                </div>
                <span style={{ fontSize: 12, fontWeight: 700, color: colors.text, textAlign: "center", lineHeight: 1.3 }}>{cat.label}</span>
                {!hasPackages && (
                  <span style={{ position: "absolute", top: 8, right: 8, width: 7, height: 7, borderRadius: 4, background: colors.border }} title="Coming soon" />
                )}
              </button>
            );
          })}
        </div>
      </div>
    </Screen>
  );
}

function iconForFragment(fragment) {
  const f = fragment.toLowerCase();
  if (f.includes("sms")) return MessageSquare;
  if (f.includes("maalin") || f.includes("saac") || f.includes("expire") || f.includes("week") || f.includes("month") || f.includes("day")) return Clock;
  return ArrowDownUp;
}

function PackagesScreen({ providerId, categoryId, onBack, onBuy }) {
  const provider = PROVIDERS.find((p) => p.id === providerId);
  const category = (CATEGORIES[providerId] || []).find((c) => c.id === categoryId);
  const pkgs = PACKAGES[providerId]?.[categoryId] || [];
  const { colors } = useTheme();
  const { t } = useI18n();
  return (
    <Screen>
      <StatusBar />
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 18px 0" }}>
        <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer" }}>
          <ChevronLeft color={colors.text} />
        </button>
        <div>
          <div style={{ fontWeight: 700, color: colors.text, fontSize: 17 }}>{provider?.name || "Unknown provider"} · {category?.label}</div>
          <div style={{ fontSize: 11.5, color: colors.textMuted }}>{t("requestInternetCode")}</div>
        </div>
      </div>
      <div style={{ padding: "10px 18px 0", fontSize: 12, color: colors.textSubtle }}>
        {t("choosePackageBelow")} {provider?.name || "this provider"}. {t("validOnlyOn")} {provider?.name || "this"}{t("network")}
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 18px 18px" }}>
        {pkgs.length === 0 && (
          <div style={{ textAlign: "center", color: colors.textMuted, fontSize: 13, marginTop: 60, padding: "0 20px" }}>
            {t("noPackagesYet")} {category?.label}. {t("checkBackSoon")}
          </div>
        )}
        {pkgs.map((pkg) => (
          <div
            key={pkg.id}
            style={{
              display: "flex",
              gap: 12,
              background: colors.surface,
              borderRadius: 16,
              marginBottom: 12,
              overflow: "hidden",
              boxShadow: "0 2px 10px rgba(20,30,90,0.06)",
            }}
          >
            <div style={{ width: 84, background: provider.color, display: "flex", alignItems: "center", justifyContent: "center", padding: 10 }}>
              {LOGOS[provider?.id] ? (
                <img src={LOGOS[provider?.id]} alt={provider?.name || "Provider"} style={{ maxHeight: "100%", maxWidth: "100%", objectFit: "contain" }} />
              ) : (
                <Router color="#fff" size={26} />
              )}
            </div>
            <div style={{ padding: "12px 12px 12px 0", flex: 1 }}>
              <div style={{ fontWeight: 700, color: colors.text, fontSize: 15 }}>{pkg?.name || "Package"}</div>
              <div style={{ marginTop: 2 }}>
                <span style={{ textDecoration: "line-through", color: colors.textMuted, fontSize: 13, marginRight: 8 }}>${pkg.old.toFixed(2)}</span>
                <span style={{ color: "#16A34A", fontWeight: 800, fontSize: 16 }}>${pkg.price.toFixed(2)}</span>
              </div>
              <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 5 }}>
                {pkg.desc.split(",").map((fragment) => {
                  const Icon = iconForFragment(fragment);
                  return (
                    <div key={fragment} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <Icon size={13} color={provider.color} strokeWidth={2.4} />
                      <span style={{ fontSize: 12.5, color: colors.textSubtle }}>{fragment.trim()}</span>
                    </div>
                  );
                })}
              </div>
              <button
                onClick={() => onBuy(pkg)}
                style={{
                  marginTop: 8,
                  border: "none",
                  background: "#1D2E8C",
                  color: "#fff",
                  fontWeight: 700,
                  fontSize: 12.5,
                  padding: "8px 16px",
                  borderRadius: 10,
                  cursor: "pointer",
                }}
              >
                {t("buyNow")}
              </button>
            </div>
          </div>
        ))}
      </div>
    </Screen>
  );
}

const ORDER_STATUS_STYLE = {
  pending: { bg: "#FFF4D9", fg: "#A9720A", dot: "#F2C200" },
  in_progress: { bg: "#E5EBFF", fg: "#1D4ED8", dot: "#1D4ED8" },
  completed: { bg: "#E4F7EA", fg: "#16A34A", dot: "#16A34A" },
  failed: { bg: "#FCE7E8", fg: "#C81E2C", dot: "#C81E2C" },
  cancelled: { bg: "#EEF0F4", fg: "#5B6389", dot: "#8791B5" },
};

function orderStatusText(status, t) {
  const key = { pending: "statusPending", in_progress: "statusInProgress", completed: "statusCompleted", failed: "statusFailed", cancelled: "statusCancelled" }[status];
  return key ? t(key) : status;
}

// Local ("mock") push notification: there's no real Web Push backend (no
// VAPID keys, no push-subscription storage), so this just asks the already-
// registered service worker (see src/main.jsx) to show a notification from
// the page itself the moment a pending/in_progress order is observed
// flipping to completed. `tag` is the order reference so a repeat call for
// the same order replaces rather than stacks. No-ops silently if the
// browser doesn't support service workers or the customer hasn't granted
// Notification permission (wired via the "Order updates" toggle in
// NotificationsPrefScreen).
async function notifyOrderStatusChange(order) {
  if (typeof window === "undefined" || !("Notification" in window) || !("serviceWorker" in navigator)) return;
  if (Notification.permission !== "granted") return;
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification("Dalab Internet", {
      body: `Your order ${order.reference} is complete — your data bundle is ready.`,
      tag: `order-${order.reference}`,
      icon: "/favicon.png",
    });
  } catch {
    // Service worker unavailable — notification just doesn't fire.
  }
}

function StatusPill({ status }) {
  const { t } = useI18n();
  const s = ORDER_STATUS_STYLE[status] || ORDER_STATUS_STYLE.pending;
  return (
    <span style={{ background: s.bg, color: s.fg, fontWeight: 700, fontSize: 11.5, padding: "4px 10px", borderRadius: 20, display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span style={{ width: 6, height: 6, borderRadius: 3, background: s.dot }} />
      {orderStatusText(status, t)}
    </span>
  );
}

function PaymentScreen({ order, senderPhone, onBack, onPaid }) {
  const [status, setStatus] = useState("idle"); // idle | processing | success
  const [sender, setSender] = useState(senderPhone || "");
  const [receiver, setReceiver] = useState("");
  const [method, setMethod] = useState("evc");
  const [schedule, setSchedule] = useState(false);
  const provider = PROVIDERS.find((p) => p.id === order.providerId);
  const { colors } = useTheme();
  const { t } = useI18n();

  const payNow = () => {
    if (!sender || status !== "idle") return;
    setStatus("processing");
    setTimeout(() => {
      setStatus("success");
      setTimeout(() => onPaid({ senderPhone: sender, receiverPhone: receiver || sender, paymentMethod: PAYMENT_METHODS.find((m) => m.id === method)?.label || method }), 800);
    }, 1500);
  };

  return (
    <Screen>
      <div style={{ background: "linear-gradient(135deg,#1CB85C,#0E7A38)", padding: "16px 18px 20px", display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer" }}>
          <ChevronLeft color="#fff" size={22} />
        </button>
        <span style={{ color: "#fff", fontWeight: 800, fontSize: 19 }}>{t("confirmPayment")}</span>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "18px 20px 20px" }}>
        <input
          value={sender}
          onChange={(e) => setSender(e.target.value.replace(/[^\d]/g, ""))}
          placeholder={t("senderNumber")}
          style={{
            width: "100%", padding: "16px 18px", borderRadius: 28, border: "1.5px solid #B7E3C6",
            fontSize: 15, fontWeight: 700, color: colors.text, outline: "none", boxSizing: "border-box",
            background: colors.inputBg,
          }}
        />
        <input
          value={receiver}
          onChange={(e) => setReceiver(e.target.value.replace(/[^\d]/g, ""))}
          placeholder={t("receiverNumber")}
          style={{
            width: "100%", padding: "16px 18px", borderRadius: 28, border: "1.5px solid #B7E3C6",
            fontSize: 15, color: colors.textMuted, outline: "none", boxSizing: "border-box", marginTop: 14,
            background: colors.inputBg,
          }}
        />

        <div style={{ fontWeight: 700, fontSize: 14.5, color: colors.text, marginTop: 20, marginBottom: 12 }}>{t("selectPaymentMethod")}</div>
        <div style={{ display: "flex", gap: 22 }}>
          {PAYMENT_METHODS.map((m) => {
            const selected = method === m.id;
            const Icon = m.icon;
            return (
              <button
                key={m.id}
                onClick={() => setMethod(m.id)}
                style={{ background: "none", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}
              >
                <div
                  style={{
                    width: 60, height: 60, borderRadius: 30, background: m.useLogo ? "#fff" : m.color,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    border: selected ? `2px solid ${m.color}` : "2px solid transparent",
                    boxShadow: selected ? `0 0 0 6px ${m.color}1A` : "none", padding: 8,
                  }}
                >
                  {m.useLogo && LOGOS[m.useLogo] ? (
                    <img src={LOGOS[m.useLogo]} alt={m.label} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
                  ) : (
                    <Icon size={24} color="#fff" />
                  )}
                </div>
                <span style={{ fontSize: 12, fontWeight: selected ? 800 : 600, color: selected ? colors.text : colors.textMuted }}>{m.label}</span>
                {selected && <div style={{ width: 18, height: 2, borderRadius: 1, background: m.color }} />}
              </button>
            );
          })}
        </div>

        <div style={{ background: "#EAF7EF", border: "1px solid #CFEEDA", borderRadius: 16, padding: 18, marginTop: 22 }}>
          <div style={{ fontWeight: 700, fontSize: 14.5, color: "#0B1240", textAlign: "center" }}>{t("serviceDetails")}</div>
          <label style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14, cursor: "pointer" }}>
            <input type="checkbox" checked={schedule} onChange={(e) => setSchedule(e.target.checked)} style={{ width: 18, height: 18 }} />
            <span style={{ fontSize: 13.5, fontWeight: 700, color: "#0B1240" }}>{t("scheduleOptional")}</span>
          </label>
          <div style={{ fontSize: 13.5, color: "#2F3A28", marginTop: 14, lineHeight: 1.6 }}>
            {order?.pkg?.name || "Package"} — {order?.pkg?.desc || ""}
          </div>
        </div>
      </div>

      <div style={{ padding: "0 20px 22px" }}>
        <button
          onClick={payNow}
          disabled={status !== "idle" || !sender}
          style={{
            width: "100%", padding: "16px 0", borderRadius: 28, border: "none",
            background: status === "idle" && sender ? "linear-gradient(90deg,#1CB85C,#149248)" : "#C9E9D5",
            color: "#fff", fontWeight: 800, fontSize: 16, letterSpacing: 0.5,
            cursor: status === "idle" && sender ? "pointer" : "default",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          }}
        >
          {status === "processing" && <Loader2 size={17} className="animate-spin" />}
          {status === "idle" ? t("payNow") : status === "processing" ? t("processing") : t("paymentConfirmed")}
        </button>
      </div>
    </Screen>
  );
}

function ReceiptScreen({ order, onDone }) {
  const provider = PROVIDERS.find((p) => p.id === order.providerId);
  const { colors } = useTheme();
  const { t } = useI18n();
  return (
    <Screen>
      <StatusBar />
      <div style={{ flex: 1, overflowY: "auto", padding: "22px 24px" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginTop: 6 }}>
          <div style={{ width: 64, height: 64, borderRadius: 32, background: "#E4F7EA", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <CheckCircle2 size={32} color="#16A34A" />
          </div>
          <div style={{ fontWeight: 800, fontSize: 18, color: colors.text, marginTop: 12 }}>{t("paymentSuccessful")}</div>
          <div style={{ fontSize: 12.5, color: colors.textMuted, marginTop: 2 }}>{order?.pkg?.name || "Package"} {t("activatedOn")} {provider?.name || "provider"}</div>
        </div>

        <div style={{ background: colors.surface, border: `1px dashed ${colors.border}`, borderRadius: 16, padding: 18, marginTop: 22 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
            <span style={{ color: colors.textMuted }}>{t("receiptNo")}</span>
            <span style={{ fontWeight: 700, color: colors.text }}>{order.reference}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginTop: 8 }}>
            <span style={{ color: colors.textMuted }}>{t("date")}</span>
            <span style={{ fontWeight: 700, color: colors.text }}>{order.date}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginTop: 8 }}>
            <span style={{ color: colors.textMuted }}>{t("provider")}</span>
            <span style={{ fontWeight: 700, color: colors.text }}>{provider?.name || "—"}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginTop: 8 }}>
            <span style={{ color: colors.textMuted }}>{t("packageLabel")}</span>
            <span style={{ fontWeight: 700, color: colors.text }}>{order?.pkg?.name || "—"}</span>
          </div>
          <div style={{ borderTop: `1px dashed ${colors.border}`, marginTop: 12, paddingTop: 12, display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: colors.text, fontWeight: 700 }}>{t("totalPaid")}</span>
            <span style={{ color: "#16A34A", fontWeight: 800, fontSize: 16 }}>${order.pkg.price.toFixed(2)}</span>
          </div>
        </div>

        <button
          style={{
            marginTop: 16,
            width: "100%",
            padding: "12px 0",
            borderRadius: 12,
            border: `1px solid ${colors.border}`,
            background: colors.surface,
            color: "#1D2E8C",
            fontWeight: 700,
            fontSize: 13.5,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            cursor: "pointer",
          }}
        >
          <Download size={15} /> {t("downloadReceipt")}
        </button>
      </div>
      <div style={{ padding: "0 24px 24px" }}>
        <button
          onClick={onDone}
          style={{
            width: "100%",
            padding: "14px 0",
            borderRadius: 14,
            border: "none",
            background: "linear-gradient(90deg,#1D2E8C,#2A3FC0)",
            color: "#fff",
            fontWeight: 700,
            fontSize: 15,
            cursor: "pointer",
          }}
        >
          {t("done")}
        </button>
      </div>
    </Screen>
  );
}

function OrderHistoryScreen({ orders, onNav, onOpenReceipt }) {
  const { colors } = useTheme();
  const { t } = useI18n();
  return (
    <Screen>
      <StatusBar />
      <div style={{ padding: "16px 20px 6px" }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: colors.text }}>{t("orderHistory")}</div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "6px 20px 12px" }}>
        {orders.length === 0 && (
          <div style={{ textAlign: "center", color: colors.textMuted, fontSize: 13, marginTop: 60 }}>{t("noOrdersYet")}</div>
        )}
        {orders.map((o) => {
          const provider = PROVIDERS.find((p) => p.id === o.providerId);
          return (
            <button
              key={o.reference}
              onClick={() => onOpenReceipt(o)}
              style={{
                width: "100%",
                textAlign: "left",
                display: "flex",
                alignItems: "center",
                gap: 12,
                background: colors.surface,
                borderRadius: 14,
                padding: 12,
                marginBottom: 10,
                border: "none",
                boxShadow: "0 2px 10px rgba(20,30,90,0.06)",
                cursor: "pointer",
              }}
            >
              <div style={{ width: 40, height: 40, borderRadius: 10, background: provider.color, display: "flex", alignItems: "center", justifyContent: "center", padding: 6, overflow: "hidden" }}>
                {LOGOS[provider?.id] ? (
                  <img src={LOGOS[provider?.id]} alt={provider?.name || "Provider"} style={{ maxHeight: "100%", maxWidth: "100%", objectFit: "contain" }} />
                ) : (
                  <Hash size={18} color="#fff" />
                )}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 13.5, color: colors.text }}>{o?.pkg?.name || "Package"} · {provider?.name || "Unknown"}</div>
                <div style={{ fontSize: 11.5, color: colors.textMuted, marginTop: 2 }}>{o.reference} · {o.date}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontWeight: 800, fontSize: 13.5, color: colors.text }}>${o.pkg.price.toFixed(2)}</div>
                <div style={{ marginTop: 4 }}><StatusPill status={o.status} /></div>
              </div>
            </button>
          );
        })}
      </div>
      <BottomNav active="orders" onNav={onNav} />
    </Screen>
  );
}

// Derives a simple Paid / Awaiting / Failed / Cancelled payment status from
// the order's real lifecycle status — the backend tracks one status field
// (pending/in_progress/completed/failed/cancelled), so "Payment Status" here
// is a presentation-layer view of that same field, distinct from the literal
// "Order Status" badge shown alongside it.
function paymentStatusFromOrderStatus(status) {
  if (status === "completed" || status === "in_progress") return "paid";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return "pending";
}

function OrderDetailsScreen({ order, onBack, onOrderUpdated }) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const [current, setCurrent] = useState(order);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(new Date());

  useEffect(() => setCurrent(order), [order]);

  const provider = PROVIDERS.find((p) => p.id === current?.providerId);

  const refresh = useCallback(
    async (silent) => {
      if (!current?.reference) return;
      if (!silent) setRefreshing(true);
      if (DALAB_API_ENABLED) {
        try {
          const fresh = await DalabApi.getOrder(current.reference);
          const merged = { ...current, status: fresh.status, ussdGenerated: fresh.ussdGenerated, completedAt: fresh.completedAt };
          if (current.status !== "completed" && fresh.status === "completed") {
            notifyOrderStatusChange(merged);
          }
          setCurrent(merged);
          onOrderUpdated?.(merged);
        } catch (err) {
          console.error("Failed to refresh order status:", err.message);
        }
      } else {
        await new Promise((r) => setTimeout(r, 600)); // demo-mode feel
      }
      setLastUpdated(new Date());
      if (!silent) setRefreshing(false);
    },
    [current, onOrderUpdated]
  );

  // Auto-refresh every 8s while this screen is open — this is polling, not a
  // WebSocket push (no `ws` package is installable in the backend's sandbox
  // either — see dalab-backend.zip's README), but it delivers the same
  // practical result: the status updates without the user manually
  // refreshing the page.
  useEffect(() => {
    if (!DALAB_API_ENABLED) return;
    const interval = setInterval(() => refresh(true), 8000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.reference]);

  if (!current) {
    return (
      <Screen>
        <StatusBar />
        <DarkHeader title={t("orderDetailsTitle")} onBack={onBack} />
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: colors.textMuted, fontSize: 13 }}>—</div>
      </Screen>
    );
  }

  const style = ORDER_STATUS_STYLE[current.status] || ORDER_STATUS_STYLE.pending;
  const paymentStatus = paymentStatusFromOrderStatus(current.status);
  const paymentStyle = { paid: ORDER_STATUS_STYLE.completed, pending: ORDER_STATUS_STYLE.pending, failed: ORDER_STATUS_STYLE.failed, cancelled: ORDER_STATUS_STYLE.cancelled }[paymentStatus];
  const statusMessageKey = { pending: "statusMsgPending", in_progress: "statusMsgInProgress", completed: "statusMsgCompleted", failed: "statusMsgFailed", cancelled: "statusMsgCancelled" }[current.status];
  const StatusIcon = { pending: Clock3, in_progress: Loader2, completed: CheckCircle2, failed: XCircle, cancelled: AlertTriangle }[current.status] || Clock3;

  const copyTxnId = () => {
    const value = current.transactionId || current.reference;
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const downloadReceipt = () => {
    // No PDF-generation library is available in this browser artifact
    // environment — the standard, dependency-free way to let a user save a
    // web page as a PDF is the browser's own print dialog ("Save as PDF"),
    // so that's what this triggers rather than faking a binary download.
    window.print?.();
  };

  const shareReceipt = async () => {
    const summary = `DALAB INTERNET Receipt\n${current.pkg?.name} — ${provider?.name}\nAmount: $${Number(current.pkg?.price ?? 0).toFixed(2)}\nOrder: ${current.reference}\nStatus: ${orderStatusText(current.status, t)}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: t("orderDetailsTitle"), text: summary });
      } catch {
        /* user cancelled the native share sheet — not an error */
      }
    } else if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(summary);
    }
  };

  const row = (label, value, opts = {}) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderTop: `1px solid ${colors.divider}`, gap: 12 }}>
      <span style={{ fontSize: 12.5, color: colors.textMuted, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 12.5, color: colors.text, fontWeight: 700, fontFamily: opts.mono ? "monospace" : "inherit", textAlign: "right", wordBreak: "break-word" }}>
        {value ?? "—"}
      </span>
    </div>
  );

  return (
    <Screen>
      <StatusBar />
      <div style={{ background: "#0B1240", padding: "16px 18px 18px", display: "flex", alignItems: "center", position: "relative" }}>
        <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer", zIndex: 1 }}>
          <ChevronLeft color="#fff" size={22} />
        </button>
        <span style={{ position: "absolute", left: 0, right: 0, textAlign: "center", color: "#fff", fontWeight: 800, fontSize: 17 }}>{t("orderDetailsTitle")}</span>
        <button onClick={() => refresh(false)} disabled={refreshing} style={{ background: "none", border: "none", cursor: "pointer", zIndex: 1, marginLeft: "auto" }}>
          <RefreshCw size={19} color="#fff" className={refreshing ? "animate-spin" : undefined} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "20px 18px 18px" }}>
        {/* Provider logo */}
        <div style={{ display: "flex", justifyContent: "center" }}>
          <div style={{ width: 64, height: 64, borderRadius: 20, background: provider?.color || colors.surfaceAlt, display: "flex", alignItems: "center", justifyContent: "center", padding: 10, boxShadow: "0 6px 16px -6px rgba(20,30,90,0.3)" }}>
            {LOGOS[provider?.id] ? (
              <img src={LOGOS[provider?.id]} alt={provider?.name || "Provider"} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
            ) : (
              <Wifi color="#fff" size={28} />
            )}
          </div>
        </div>

        {/* Success / pending / failed message banner */}
        <div style={{ background: style.bg, borderRadius: 16, padding: 16, marginTop: 16, display: "flex", alignItems: "center", gap: 12 }}>
          <StatusIcon size={22} color={style.fg} className={current.status === "in_progress" ? "animate-spin" : undefined} />
          <div>
            <div style={{ fontWeight: 800, fontSize: 14, color: style.fg }}>{orderStatusText(current.status, t)}</div>
            <div style={{ fontSize: 11.5, color: colors.textSubtle, marginTop: 1 }}>{t(statusMessageKey)}</div>
          </div>
        </div>

        {/* Status badges row */}
        <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
          <div style={{ flex: 1, background: colors.surface, borderRadius: 12, padding: "10px 12px", boxShadow: "0 2px 8px rgba(20,30,90,0.05)" }}>
            <div style={{ fontSize: 10.5, color: colors.textMuted, fontWeight: 700, marginBottom: 4 }}>{t("paymentStatusLabel").toUpperCase()}</div>
            <span style={{ background: paymentStyle.bg, color: paymentStyle.fg, fontWeight: 700, fontSize: 11.5, padding: "3px 9px", borderRadius: 20 }}>
              {paymentStatus === "paid" ? t("paymentPaid") : paymentStatus === "pending" ? t("paymentAwaiting") : orderStatusText(current.status, t)}
            </span>
          </div>
          <div style={{ flex: 1, background: colors.surface, borderRadius: 12, padding: "10px 12px", boxShadow: "0 2px 8px rgba(20,30,90,0.05)" }}>
            <div style={{ fontSize: 10.5, color: colors.textMuted, fontWeight: 700, marginBottom: 4 }}>{t("orderStatusLabel").toUpperCase()}</div>
            <StatusPill status={current.status} />
          </div>
        </div>

        {/* Receipt card */}
        <div style={{ background: colors.surface, border: `1px dashed ${colors.border}`, borderRadius: 16, padding: 18, marginTop: 16 }}>
          {row(t("serviceName"), current.pkg?.name)}
          {row(t("orderNumber"), current.reference, { mono: true })}
          {row(t("customerPhoneLabel"), current.senderPhone, { mono: true })}
          {row(t("recipientPhoneLabel"), current.receiverPhone, { mono: true })}
          {row(t("telecomProvider"), provider?.name)}
          {row(t("internetPackage"), current.pkg?.name)}
          {row(t("packagePrice"), `$${Number(current.pkg?.price ?? 0).toFixed(2)}`)}
          {row(t("paymentMethodLabel"), current.paymentMethod)}
          {row(t("paymentAmount"), `$${Number(current.pkg?.price ?? 0).toFixed(2)}`)}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderTop: `1px solid ${colors.divider}`, gap: 12 }}>
            <span style={{ fontSize: 12.5, color: colors.textMuted }}>{t("transactionIdLabel")}</span>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 12.5, color: colors.text, fontWeight: 700, fontFamily: "monospace" }}>{current.transactionId || current.reference}</span>
              <button onClick={copyTxnId} title={t("copyTransactionId")} style={{ background: "none", border: "none", cursor: "pointer", display: "flex" }}>
                {copied ? <CheckCircle2 size={14} color="#16A34A" /> : <Copy size={14} color={colors.textMuted} />}
              </button>
            </div>
          </div>
          {row(t("orderDateTime"), current.date, { mono: true })}
        </div>

        {current.ussdGenerated && (
          <div style={{ background: "#0B1240", borderRadius: 12, padding: 12, marginTop: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <span style={{ color: "#22B24C", fontFamily: "monospace", fontSize: 12.5, fontWeight: 700, wordBreak: "break-all" }}>{current.ussdGenerated}</span>
          </div>
        )}

        {/* Actions */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 18 }}>
          <button
            onClick={downloadReceipt}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: "100%", padding: "13px 0", borderRadius: 12, border: `1px solid ${colors.border}`, background: colors.surface, color: "#1D2E8C", fontWeight: 700, fontSize: 13.5, cursor: "pointer" }}
          >
            <Printer size={16} /> {t("downloadReceiptPdf")}
          </button>
          <button
            onClick={shareReceipt}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: "100%", padding: "13px 0", borderRadius: 12, border: "none", background: "linear-gradient(90deg,#1D2E8C,#2A3FC0)", color: "#fff", fontWeight: 700, fontSize: 13.5, cursor: "pointer" }}
          >
            <Share2 size={16} /> {t("shareReceipt")}
          </button>
        </div>

        <div style={{ textAlign: "center", fontSize: 10.5, color: colors.textMuted, marginTop: 14 }}>
          {refreshing ? t("refreshing") : `${t("lastUpdated")}: ${lastUpdated.toLocaleTimeString()}`}
        </div>
      </div>
    </Screen>
  );
}

function DarkHeader({ title, onBack }) {
  return (
    <div style={{ background: "#0B1240", padding: "16px 18px 18px", display: "flex", alignItems: "center", position: "relative" }}>
      <button onClick={onBack} style={{ background: "none", border: "none", cursor: "pointer", zIndex: 1 }}>
        <ChevronLeft color="#fff" size={22} />
      </button>
      <span style={{ position: "absolute", left: 0, right: 0, textAlign: "center", color: "#fff", fontWeight: 800, fontSize: 17 }}>{title}</span>
    </div>
  );
}

function ProfileRow({ icon: Icon, label, onClick, danger, value }) {
  const { colors } = useTheme();
  return (
    <button
      onClick={onClick}
      style={{
        width: "100%", display: "flex", alignItems: "center", gap: 14, background: "none", border: "none",
        padding: "14px 18px", cursor: "pointer", textAlign: "left",
      }}
    >
      <Icon size={19} color={danger ? "#C81E2C" : colors.textSubtle} />
      <span style={{ flex: 1, fontSize: 14.5, color: danger ? "#C81E2C" : colors.text, fontWeight: 500 }}>{label}</span>
      {value && <span style={{ fontSize: 13, color: colors.textMuted, marginRight: 4 }}>{value}</span>}
      {!danger && <ChevronRight size={17} color={colors.textMuted} />}
    </button>
  );
}

function ProfileMain({ onNavigate, onDeleteRequest, onNav }) {
  const { colors } = useTheme();
  const { t } = useI18n();
  return (
    <Screen>
      <StatusBar />
      <DarkHeader title={t("profileTitle")} onBack={() => onNav("home")} />
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 16px 12px", display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ background: colors.surface, borderRadius: 18, padding: "24px 16px", display: "flex", flexDirection: "column", alignItems: "center", boxShadow: "0 2px 10px rgba(20,30,90,0.05)" }}>
          <div style={{ position: "relative" }}>
            <div style={{ width: 84, height: 84, borderRadius: 42, background: "#DCEBFF", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <User size={40} color="#1D2E8C" />
            </div>
            <div style={{ position: "absolute", right: -2, bottom: -2, width: 28, height: 28, borderRadius: 14, background: "#16A34A", display: "flex", alignItems: "center", justifyContent: "center", border: `3px solid ${colors.surface}` }}>
              <Pencil size={12} color="#fff" />
            </div>
          </div>
          <div style={{ marginTop: 12, fontSize: 18, fontWeight: 800, color: colors.text }}>Yaaain</div>
        </div>

        <div style={{ background: colors.surface, borderRadius: 18, boxShadow: "0 2px 10px rgba(20,30,90,0.05)" }}>
          <ProfileRow icon={Settings2} label={t("menuSetting")} onClick={() => onNavigate("settings")} />
          <div style={{ height: 1, background: colors.divider, margin: "0 18px" }} />
          <ProfileRow icon={Bell} label={t("menuNotifications")} onClick={() => onNavigate("notifications")} />
        </div>

        <div style={{ background: colors.surface, borderRadius: 18, boxShadow: "0 2px 10px rgba(20,30,90,0.05)" }}>
          <ProfileRow icon={MessageCircle} label={t("menuFeedback")} onClick={() => onNavigate("feedback")} />
          <div style={{ height: 1, background: colors.divider, margin: "0 18px" }} />
          <ProfileRow icon={ThumbsUp} label={t("menuRateApp")} onClick={() => onNavigate("rate")} />
          <div style={{ height: 1, background: colors.divider, margin: "0 18px" }} />
          <ProfileRow icon={Share2} label={t("menuInvite")} onClick={() => onNavigate("referral")} />
        </div>

        <div style={{ background: colors.surface, borderRadius: 18, boxShadow: "0 2px 10px rgba(20,30,90,0.05)" }}>
          <ProfileRow icon={LogOut} label={t("menuDeleteAccount")} onClick={onDeleteRequest} danger />
        </div>
      </div>
      <BottomNav active="profile" onNav={onNav} />
    </Screen>
  );
}

function ToggleRow({ title, subtitle, checked, onChange }) {
  const { colors } = useTheme();
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: `1px solid ${colors.divider}` }}>
      <div>
        <div style={{ fontSize: 14.5, color: colors.text, fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>{subtitle}</div>
      </div>
      <button
        onClick={() => onChange(!checked)}
        style={{
          width: 44, height: 26, borderRadius: 13, border: "none", cursor: "pointer",
          background: checked ? "#16A34A" : colors.border, position: "relative", flexShrink: 0, transition: "background .2s",
        }}
      >
        <div style={{
          width: 20, height: 20, borderRadius: 10, background: "#fff", position: "absolute", top: 3,
          left: checked ? 21 : 3, transition: "left .2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
        }} />
      </button>
    </div>
  );
}

function InfoSheet({ title, body, onClose }) {
  const { colors } = useTheme();
  return (
    <div style={{ position: "absolute", inset: 0, background: "rgba(11,18,64,0.45)", display: "flex", alignItems: "flex-end", borderRadius: 40, overflow: "hidden" }}>
      <div style={{ background: colors.surface, width: "100%", maxHeight: "70%", borderRadius: "20px 20px 0 0", padding: 22, overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <span style={{ fontWeight: 800, fontSize: 17, color: colors.text }}>{title}</span>
          <button onClick={onClose} style={{ background: colors.surfaceAlt, border: "none", borderRadius: 16, width: 32, height: 32, cursor: "pointer" }}>
            <X size={16} color={colors.textSubtle} />
          </button>
        </div>
        <div style={{ fontSize: 13.5, color: colors.textSubtle, lineHeight: 1.7 }}>{body}</div>
      </div>
    </div>
  );
}

function ThemeOptionRow({ mode, label, icon: Icon, selected, onSelect, colors }) {
  return (
    <button
      onClick={onSelect}
      style={{
        width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "12px 14px",
        borderRadius: 12, border: `1.5px solid ${selected ? "#1D2E8C" : colors.border}`,
        background: selected ? "#1D2E8C11" : "transparent", cursor: "pointer", marginBottom: 8,
      }}
    >
      <Icon size={18} color={selected ? "#1D2E8C" : colors.textSubtle} />
      <span style={{ flex: 1, textAlign: "left", fontSize: 14, fontWeight: 600, color: colors.text }}>{label}</span>
      <div style={{
        width: 18, height: 18, borderRadius: 9, border: `2px solid ${selected ? "#1D2E8C" : colors.border}`,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {selected && <div style={{ width: 9, height: 9, borderRadius: 5, background: "#1D2E8C" }} />}
      </div>
    </button>
  );
}

function SettingsScreen({ onBack, onLogout }) {
  const [notifOn, setNotifOn] = useState(false);
  const [smsOn, setSmsOn] = useState(false);
  const [sheet, setSheet] = useState(null); // 'privacy' | 'terms' | 'support' | 'about' | 'logout' | null
  const { colors, mode, setMode } = useTheme();
  const { t, lang, setLang, languages } = useI18n();

  return (
    <Screen>
      <StatusBar />
      <DarkHeader title={t("settingsTitle")} onBack={onBack} />
      <div style={{ flex: 1, overflowY: "auto" }}>
        {/* Theme */}
        <div style={{ padding: "18px 20px 6px" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: colors.text, marginBottom: 2 }}>{t("settingsTheme")}</div>
          <div style={{ fontSize: 11.5, color: colors.textMuted, marginBottom: 12 }}>{t("settingsThemeDesc")}</div>
          <ThemeOptionRow mode="light" label={t("themeLight")} icon={Sun} selected={mode === "light"} onSelect={() => setMode("light")} colors={colors} />
          <ThemeOptionRow mode="dark" label={t("themeDark")} icon={Moon} selected={mode === "dark"} onSelect={() => setMode("dark")} colors={colors} />
          <ThemeOptionRow mode="system" label={t("themeSystem")} icon={Monitor} selected={mode === "system"} onSelect={() => setMode("system")} colors={colors} />
        </div>

        {/* Language */}
        <div style={{ padding: "10px 20px 18px", borderBottom: `1px solid ${colors.divider}` }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: colors.text, marginBottom: 2 }}>{t("settingsLanguage")}</div>
          <div style={{ fontSize: 11.5, color: colors.textMuted, marginBottom: 12 }}>{t("settingsLanguageDesc")}</div>
          <div style={{ display: "flex", gap: 10 }}>
            {languages.map((l) => (
              <button
                key={l.code}
                onClick={() => setLang(l.code)}
                style={{
                  flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                  padding: "12px 0", borderRadius: 12, cursor: "pointer",
                  border: `1.5px solid ${lang === l.code ? "#1D2E8C" : colors.border}`,
                  background: lang === l.code ? "#1D2E8C11" : "transparent",
                  fontSize: 14, fontWeight: 700, color: colors.text,
                }}
              >
                <span style={{ fontSize: 18 }}>{l.flag}</span> {l.label}
              </button>
            ))}
          </div>
        </div>

        {/* Notifications */}
        <ToggleRow title={t("receiveNotifOnDevice")} subtitle={notifOn ? t("disableNotification") : t("enableNotification")} checked={notifOn} onChange={setNotifOn} />
        <ToggleRow title={t("receiveSmsOnDevice")} subtitle={smsOn ? t("disableSms") : t("enableSms")} checked={smsOn} onChange={setSmsOn} />

        {/* Legal / support / about */}
        <ProfileRow icon={Lock} label={t("settingsPrivacy")} onClick={() => setSheet("privacy")} />
        <div style={{ height: 1, background: colors.divider, margin: "0 18px" }} />
        <ProfileRow icon={FileText} label={t("settingsTerms")} onClick={() => setSheet("terms")} />
        <div style={{ height: 1, background: colors.divider, margin: "0 18px" }} />
        <ProfileRow icon={HelpCircle} label={t("settingsContactSupport")} onClick={() => setSheet("support")} />
        <div style={{ height: 1, background: colors.divider, margin: "0 18px" }} />
        <ProfileRow icon={Info} label={t("settingsAbout")} onClick={() => setSheet("about")} />
        <div style={{ height: 1, background: colors.divider, margin: "0 18px" }} />
        <ProfileRow icon={Smartphone} label={t("settingsAppVersion")} value="1.0.0" onClick={() => {}} />
        <div style={{ height: 1, background: colors.divider, margin: "0 18px" }} />
        <ProfileRow icon={LogOut} label={t("settingsLogout")} onClick={() => setSheet("logout")} danger />
      </div>

      {sheet === "privacy" && <InfoSheet title={t("settingsPrivacy")} body={t("aboutBody")} onClose={() => setSheet(null)} />}
      {sheet === "terms" && <InfoSheet title={t("settingsTerms")} body={t("aboutBody")} onClose={() => setSheet(null)} />}
      {sheet === "about" && <InfoSheet title={t("settingsAbout")} body={t("aboutBody")} onClose={() => setSheet(null)} />}
      {sheet === "support" && <SupportSheet onClose={() => setSheet(null)} />}
      {sheet === "logout" && (
        <div style={{ position: "absolute", inset: 0, background: "rgba(11,18,64,0.5)", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 40, overflow: "hidden", padding: 24 }}>
          <div style={{ background: colors.surface, borderRadius: 20, padding: 26, width: "100%", textAlign: "center" }}>
            <div style={{ width: 56, height: 56, borderRadius: 28, background: "#FCE7E8", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto" }}>
              <LogOut size={26} color="#C81E2C" />
            </div>
            <div style={{ fontWeight: 800, fontSize: 17, color: colors.text, marginTop: 14 }}>{t("logoutConfirmTitle")}</div>
            <div style={{ fontSize: 13, color: colors.textSubtle, marginTop: 8, lineHeight: 1.6 }}>{t("logoutConfirmBody")}</div>
            <div style={{ display: "flex", gap: 12, marginTop: 22 }}>
              <button onClick={() => setSheet(null)} style={{ flex: 1, padding: "12px 0", borderRadius: 24, border: `1px solid ${colors.border}`, background: "none", color: colors.textSubtle, fontWeight: 700, fontSize: 14, cursor: "pointer" }}>{t("cancel")}</button>
              <button onClick={onLogout} style={{ flex: 1, padding: "12px 0", borderRadius: 24, border: "none", background: "#C81E2C", color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer" }}>{t("settingsLogout")}</button>
            </div>
          </div>
        </div>
      )}
    </Screen>
  );
}

function NotificationsPrefScreen({ onBack }) {
  // Reflects real browser Notification permission rather than a fake local
  // default — see notifyOrderStatusChange, which checks Notification.permission
  // directly and is the actual source of truth this toggle is driving.
  const [orderUpdates, setOrderUpdates] = useState(
    typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted"
  );
  const [promos, setPromos] = useState(true);
  const { t } = useI18n();

  const toggleOrderUpdates = (value) => {
    if (value && typeof window !== "undefined" && "Notification" in window) {
      Notification.requestPermission().then((permission) => setOrderUpdates(permission === "granted"));
    } else {
      setOrderUpdates(false);
    }
  };

  return (
    <Screen>
      <StatusBar />
      <DarkHeader title={t("settingsNotifications")} onBack={onBack} />
      <div style={{ flex: 1, overflowY: "auto" }}>
        <ToggleRow title={t("orderUpdates")} subtitle={t("orderUpdatesDesc")} checked={orderUpdates} onChange={toggleOrderUpdates} />
        <ToggleRow title={t("promotions")} subtitle={t("promotionsDesc")} checked={promos} onChange={setPromos} />
      </div>
    </Screen>
  );
}

const ISSUE_OPTION_KEYS = ["issueAppCrashes", "issuePaymentFailed", "issuePaymentDeducted", "issueFeedback", "issueOther"];

function IssueSheet({ selected, onSelect, onClose }) {
  const { colors } = useTheme();
  const { t } = useI18n();
  return (
    <div style={{ position: "absolute", inset: 0, background: "rgba(11,18,64,0.45)", display: "flex", alignItems: "flex-end", borderRadius: 40, overflow: "hidden" }}>
      <div style={{ background: colors.surface, width: "100%", borderRadius: "20px 20px 0 0", paddingBottom: 8 }}>
        <div style={{ width: 40, height: 4, borderRadius: 2, background: colors.border, margin: "10px auto" }} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 20px 14px" }}>
          <span style={{ fontWeight: 800, fontSize: 17, color: colors.text }}>{t("selectIssue")}</span>
          <button onClick={onClose} style={{ background: colors.surfaceAlt, border: "none", borderRadius: 16, width: 32, height: 32, cursor: "pointer" }}>
            <X size={16} color={colors.textSubtle} />
          </button>
        </div>
        <div style={{ borderTop: `1px solid ${colors.divider}` }}>
          {ISSUE_OPTION_KEYS.map((key) => {
            const opt = t(key);
            return (
              <button
                key={key}
                onClick={() => { onSelect(opt); onClose(); }}
                style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px", background: "none", border: "none", borderBottom: `1px solid ${colors.divider}`, cursor: "pointer", textAlign: "left" }}
              >
                <span style={{ fontSize: 14.5, color: colors.text }}>{opt}</span>
                <div style={{ width: 20, height: 20, borderRadius: 10, border: `2px solid ${selected === opt ? "#1D2E8C" : colors.border}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {selected === opt && <div style={{ width: 10, height: 10, borderRadius: 5, background: "#1D2E8C" }} />}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function FeedbackScreen({ onBack }) {
  const [issueSheetOpen, setIssueSheetOpen] = useState(false);
  const [issue, setIssue] = useState("");
  const [text, setText] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const { colors } = useTheme();
  const { t } = useI18n();

  if (submitted) {
    return (
      <Screen>
        <StatusBar />
        <DarkHeader title={t("feedbackTitle")} onBack={onBack} />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 30, textAlign: "center" }}>
          <div style={{ width: 64, height: 64, borderRadius: 32, background: "#E4F7EA", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <CheckCircle2 size={32} color="#16A34A" />
          </div>
          <div style={{ fontWeight: 800, fontSize: 16, color: colors.text, marginTop: 14 }}>{t("thanksForFeedback")}</div>
          <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 4 }}>{t("teamWillReview")}</div>
        </div>
      </Screen>
    );
  }

  return (
    <Screen>
      <StatusBar />
      <DarkHeader title={t("feedbackTitle")} onBack={onBack} />
      <div style={{ flex: 1, overflowY: "auto", padding: "22px 20px", display: "flex", flexDirection: "column", alignItems: "center" }}>
        <div style={{ width: 80, height: 80, borderRadius: 40, background: colors.surfaceAlt, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <User size={38} color="#1D2E8C" />
        </div>
        <div style={{ marginTop: 10, fontSize: 16, fontWeight: 800, color: colors.text }}>Yaaain</div>

        <button
          onClick={() => setIssueSheetOpen(true)}
          style={{ width: "100%", marginTop: 22, background: colors.surfaceAlt, border: "none", borderRadius: 14, padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}
        >
          <span style={{ fontSize: 14, color: issue ? colors.text : colors.textMuted }}>{issue || t("selectTitle")}</span>
          <ChevronDownIcon />
        </button>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("writeYourFeedback")}
          style={{ width: "100%", marginTop: 14, minHeight: 220, background: colors.surfaceAlt, border: "none", borderRadius: 14, padding: 16, fontSize: 13.5, color: colors.text, outline: "none", resize: "none", boxSizing: "border-box", fontFamily: "inherit" }}
        />
      </div>
      <div style={{ padding: "0 20px 22px" }}>
        <button
          onClick={() => (issue || text) && setSubmitted(true)}
          style={{ width: "100%", padding: "14px 0", borderRadius: 14, border: "none", background: "#0B1240", color: "#fff", fontWeight: 700, fontSize: 15, cursor: "pointer" }}
        >
          {t("submit")}
        </button>
      </div>
      {issueSheetOpen && <IssueSheet selected={issue} onSelect={setIssue} onClose={() => setIssueSheetOpen(false)} />}
    </Screen>
  );
}

function ChevronDownIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8791B5" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function ReferralScreen({ onBack }) {
  const { colors } = useTheme();
  const { t } = useI18n();
  return (
    <Screen>
      <StatusBar />
      <DarkHeader title={t("referralTitle")} onBack={onBack} />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", padding: "40px 30px 0", textAlign: "center" }}>
        <Gift size={90} color="#16A34A" strokeWidth={1.3} />
        <div style={{ fontSize: 19, fontWeight: 800, color: colors.text, marginTop: 20 }}>{t("inviteFriendsTitle")}</div>
        <div style={{ fontSize: 13.5, color: colors.textMuted, marginTop: 10, lineHeight: 1.6 }}>
          {t("inviteFriendsBody")}
        </div>
      </div>
      <div style={{ padding: "0 20px 22px" }}>
        <button style={{ width: "100%", padding: "14px 0", borderRadius: 14, border: "none", background: "#0B1240", color: "#fff", fontWeight: 700, fontSize: 15, letterSpacing: 0.5, cursor: "pointer" }}>
          {t("inviteFriendsButton")}
        </button>
      </div>
    </Screen>
  );
}

function RateModal({ onClose }) {
  const [stars, setStars] = useState(0);
  const { colors } = useTheme();
  const { t } = useI18n();
  return (
    <div style={{ position: "absolute", inset: 0, background: "rgba(11,18,64,0.45)", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 40, overflow: "hidden", padding: 24 }}>
      <div style={{ background: colors.surface, borderRadius: 20, padding: 26, width: "100%", textAlign: "center" }}>
        <div style={{ fontWeight: 800, fontSize: 16, color: colors.text }}>{t("rateTitle")}</div>
        <div style={{ fontSize: 12.5, color: colors.textMuted, marginTop: 4 }}>{t("rateSubtitle")}</div>
        <div style={{ display: "flex", justifyContent: "center", gap: 6, marginTop: 16 }}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} onClick={() => setStars(n)} style={{ background: "none", border: "none", cursor: "pointer" }}>
              <Star size={28} color={n <= stars ? "#F2C200" : colors.border} fill={n <= stars ? "#F2C200" : "none"} />
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 22 }}>
          <button onClick={onClose} style={{ flex: 1, padding: "12px 0", borderRadius: 12, border: `1px solid ${colors.border}`, background: colors.surface, color: colors.textSubtle, fontWeight: 700, fontSize: 13.5, cursor: "pointer" }}>{t("notNow")}</button>
          <button onClick={onClose} style={{ flex: 1, padding: "12px 0", borderRadius: 12, border: "none", background: "#1D2E8C", color: "#fff", fontWeight: 700, fontSize: 13.5, cursor: "pointer" }}>{t("submit")}</button>
        </div>
      </div>
    </div>
  );
}

function DeleteConfirmModal({ onCancel, onConfirm }) {
  const { colors } = useTheme();
  const { t } = useI18n();
  return (
    <div style={{ position: "absolute", inset: 0, background: "rgba(11,18,64,0.5)", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 40, overflow: "hidden", padding: 24 }}>
      <div style={{ background: colors.surface, borderRadius: 20, padding: 26, width: "100%", textAlign: "center" }}>
        <div style={{ width: 56, height: 56, borderRadius: 28, background: "#E4F7EA", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto" }}>
          <Info size={26} color="#16A34A" />
        </div>
        <div style={{ fontWeight: 800, fontSize: 17, color: "#16A34A", marginTop: 14 }}>{t("deleteConfirmTitle")}</div>
        <div style={{ fontSize: 13, color: colors.textSubtle, marginTop: 8, lineHeight: 1.6 }}>{t("deleteConfirmBody")}</div>
        <div style={{ display: "flex", gap: 12, marginTop: 22 }}>
          <button onClick={onConfirm} style={{ flex: 1, padding: "12px 0", borderRadius: 24, border: "none", background: "#16A34A", color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer" }}>{t("deleteYes")}</button>
          <button onClick={onCancel} style={{ flex: 1, padding: "12px 0", borderRadius: 24, border: "none", background: "#DC2626", color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer" }}>{t("deleteNo")}</button>
        </div>
      </div>
    </div>
  );
}

function ProfileFlow({ onNav, onLogout }) {
  const [sub, setSub] = useState("main");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [rateOpen, setRateOpen] = useState(false);

  const goHome = () => onNav("home");

  const handleNavigate = (target) => {
    if (target === "rate") setRateOpen(true);
    else setSub(target);
  };

  let body;
  if (sub === "settings") body = <SettingsScreen onBack={() => setSub("main")} onLogout={onLogout} />;
  else if (sub === "notifications") body = <NotificationsPrefScreen onBack={() => setSub("main")} />;
  else if (sub === "feedback") body = <FeedbackScreen onBack={() => setSub("main")} />;
  else if (sub === "referral") body = <ReferralScreen onBack={() => setSub("main")} />;
  else body = <ProfileMain onNavigate={handleNavigate} onDeleteRequest={() => setDeleteOpen(true)} onNav={onNav} />;

  return (
    <div style={{ position: "relative" }}>
      {body}
      {rateOpen && (
        <div style={{ position: "absolute", inset: 0, width: 375, height: 780, borderRadius: 40, overflow: "hidden" }}>
          <RateModal onClose={() => setRateOpen(false)} />
        </div>
      )}
      {deleteOpen && (
        <div style={{ position: "absolute", inset: 0, width: 375, height: 780, borderRadius: 40, overflow: "hidden" }}>
          <DeleteConfirmModal onCancel={() => setDeleteOpen(false)} onConfirm={() => { setDeleteOpen(false); goHome(); }} />
        </div>
      )}
    </div>
  );
}

function SupportSheet({ onClose }) {
  const { colors } = useTheme();
  const { t } = useI18n();
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "rgba(11,18,64,0.45)",
        display: "flex",
        alignItems: "flex-end",
        borderRadius: 40,
        overflow: "hidden",
      }}
    >
      <div style={{ background: colors.surface, width: "100%", borderRadius: "24px 24px 0 0", padding: 22 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontWeight: 800, color: colors.text, fontSize: 16 }}>{t("supportTitle")}</span>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer" }}>
            <X size={20} color={colors.textMuted} />
          </button>
        </div>
        <div style={{ fontSize: 13, color: colors.textSubtle, marginTop: 6 }}>0610808086</div>
        <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
          <div style={{ flex: 1, background: "#1D2E8C", borderRadius: 14, padding: "14px 0", textAlign: "center", color: "#fff", fontWeight: 700, display: "flex", gap: 8, justifyContent: "center", alignItems: "center" }}>
            <Phone size={16} /> {t("supportCall")}
          </div>
          <div style={{ flex: 1, background: "#16A34A", borderRadius: 14, padding: "14px 0", textAlign: "center", color: "#fff", fontWeight: 700, display: "flex", gap: 8, justifyContent: "center", alignItems: "center" }}>
            <MessageSquare size={16} /> {t("supportWhatsapp")}
          </div>
        </div>
      </div>
    </div>
  );
}

function PlaceholderTab({ label, onNav }) {
  return (
    <Screen>
      <StatusBar />
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#8791B5", fontSize: 14 }}>
        {label} screen
      </div>
      <BottomNav active={label.toLowerCase()} onNav={onNav} />
    </Screen>
  );
}

function AppInner() {
  const [screen, setScreen] = useState("login");
  const [phone, setPhone] = useState("");
  const [providerId, setProviderId] = useState(null);
  const [categoryId, setCategoryId] = useState(null);
  const [supportOpen, setSupportOpen] = useState(false);
  const [activeOrder, setActiveOrder] = useState(null);
  const [receiptOrder, setReceiptOrder] = useState(null);
  const [orders, setOrders] = useState([
    {
      reference: "DLB284739201",
      providerId: "hormuud",
      pkg: PACKAGES.hormuud["anfac-plus"][2],
      date: "22 Jul 2026",
      status: "completed",
      senderPhone: "252611234567",
      receiverPhone: "252611234567",
      paymentMethod: "EVC Plus",
      transactionId: "TXN7183920045",
    },
  ]);

  let content;
  if (screen === "login") {
    content = (
      <SplashLogin
        onLogin={(p) => {
          setPhone(p);
          setScreen("otp");
        }}
      />
    );
  } else if (screen === "otp") {
    content = <OtpScreen phone={phone} onBack={() => setScreen("login")} onVerified={() => setScreen("home")} />;
  } else if (screen === "home") {
    content = (
      <HomeScreen
        onSelectProvider={(id) => {
          setProviderId(id);
          setScreen("category");
        }}
        onNav={(tab) => setScreen(tab === "home" ? "home" : tab)}
        onSupport={() => setSupportOpen(true)}
      />
    );
  } else if (screen === "category") {
    content = (
      <CategoryScreen
        providerId={providerId}
        onBack={() => setScreen("home")}
        onSelectCategory={(catId) => {
          setCategoryId(catId);
          setScreen("packages");
        }}
      />
    );
  } else if (screen === "packages") {
    content = (
      <PackagesScreen
        providerId={providerId}
        categoryId={categoryId}
        onBack={() => setScreen("category")}
        onBuy={async (pkg) => {
          if (DALAB_API_ENABLED) {
            try {
              const realOrder = await DalabApi.createOrder(providerId, pkg.id);
              const order = { reference: realOrder.id, providerId, pkg, date: realOrder.createdAt, status: "pending" };
              setActiveOrder(order);
              setOrders((prev) => [order, ...prev]);
              setScreen("payment");
            } catch (err) {
              // Falls back to local-only order so the flow never dead-ends if
              // the API call fails (offline, expired token, etc.) — a real
              // deployment would surface this as a toast/error state instead.
              console.error("createOrder failed, continuing in local mode:", err.message);
            }
            return;
          }
          const order = {
            reference: genReference(),
            providerId,
            pkg,
            date: new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }),
            status: "pending",
          };
          setActiveOrder(order);
          setOrders((prev) => [order, ...prev]);
          setScreen("payment");
        }}
      />
    );
  } else if (screen === "payment") {
    content = (
      <PaymentScreen
        order={activeOrder}
        senderPhone={phone}
        onBack={() => setScreen("packages")}
        onPaid={({ senderPhone, receiverPhone, paymentMethod }) => {
          const updated = {
            ...activeOrder,
            status: "in_progress", // payment confirmed; a real deployment moves this via the agent/admin verify flow — see dalab-backend.zip
            senderPhone,
            receiverPhone,
            paymentMethod,
            transactionId: activeOrder?.transactionId || genReference(),
          };
          setOrders((prev) => prev.map((o) => (o.reference === updated.reference ? updated : o)));
          setActiveOrder(updated);
          setReceiptOrder(updated);
          setScreen("receipt");
        }}
      />
    );
  } else if (screen === "receipt") {
    content = <ReceiptScreen order={receiptOrder} onDone={() => setScreen("home")} />;
  } else if (screen === "orders") {
    content = (
      <OrderHistoryScreen
        orders={orders}
        onNav={(tab) => setScreen(tab)}
        onOpenReceipt={(o) => {
          setReceiptOrder(o);
          setScreen("orderDetails");
        }}
      />
    );
  } else if (screen === "orderDetails") {
    content = (
      <OrderDetailsScreen
        order={receiptOrder}
        onBack={() => setScreen("orders")}
        onOrderUpdated={(updated) => {
          setReceiptOrder(updated);
          setOrders((prev) => prev.map((o) => (o.reference === updated.reference ? updated : o)));
        }}
      />
    );
  } else if (screen === "profile") {
    content = (
      <ProfileFlow
        onNav={(tab) => setScreen(tab)}
        onLogout={() => {
          dalabAccessToken = null;
          setPhone("");
          setScreen("login");
        }}
      />
    );
  } else {
    content = <PlaceholderTab label={screen[0].toUpperCase() + screen.slice(1)} onNav={(tab) => setScreen(tab)} />;
  }

  return (
    <div style={{ minHeight: "100vh", background: "#0B1240", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, position: "relative" }}>
      <div style={{ position: "relative" }}>
        {content}
        {supportOpen && screen === "home" && (
          <div style={{ position: "absolute", inset: 0, width: 375, height: 780, borderRadius: 40, overflow: "hidden" }}>
            <SupportSheet onClose={() => setSupportOpen(false)} />
          </div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <I18nProvider>
        <AppInner />
      </I18nProvider>
    </ThemeProvider>
  );
}
