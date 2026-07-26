import { NativeEventEmitter, NativeModules, PermissionsAndroid, Platform, Linking } from "react-native";
import { PermissionStatus, RawSms } from "../types/sms";

/**
 * The native side (android/SmsListenerModule in this same delivery) exposes:
 *   - a `startListening()` / `stopListening()` pair
 *   - an event named "onSmsReceived" with payload { sender, body, timestampMs }
 * via DeviceEventEmitter, backed by a manifest-declared BroadcastReceiver for
 * android.provider.Telephony.SMS_RECEIVED — the same protected-broadcast
 * pattern already used in the native Kotlin Agent App, just bridged into RN.
 *
 * There is no cross-platform JS API for reading SMS — this genuinely requires
 * native code, which is why android/SmsListenerModule ships alongside this
 * hook rather than the hook trying to fake it in pure JS.
 */
const { SmsListenerModule } = NativeModules as {
  SmsListenerModule?: {
    startListening: () => void;
    stopListening: () => void;
  };
};

export function isNativeModuleAvailable(): boolean {
  return Platform.OS === "android" && Boolean(SmsListenerModule);
}

export function subscribeToIncomingSms(onSms: (raw: RawSms) => void): () => void {
  if (!SmsListenerModule) {
    // No-op unsubscribe — the hook surfaces NATIVE_MODULE_UNAVAILABLE via
    // onError so the UI can explain this instead of silently doing nothing.
    return () => {};
  }
  const emitter = new NativeEventEmitter(NativeModules.SmsListenerModule);
  const subscription = emitter.addListener("onSmsReceived", (payload: RawSms) => onSms(payload));
  SmsListenerModule.startListening();
  return () => {
    subscription.remove();
    SmsListenerModule?.stopListening();
  };
}

const REQUIRED_PERMISSIONS = [
  PermissionsAndroid.PERMISSIONS.RECEIVE_SMS,
  PermissionsAndroid.PERMISSIONS.READ_SMS,
] as const;

/** Checks current status without prompting — used on mount to decide the initial UI state. */
export async function checkSmsPermissions(): Promise<PermissionStatus> {
  if (Platform.OS !== "android") return "unavailable";
  const results = await Promise.all(REQUIRED_PERMISSIONS.map((p) => PermissionsAndroid.check(p)));
  return results.every(Boolean) ? "granted" : "denied";
}

/**
 * Requests both READ_SMS and RECEIVE_SMS. Distinguishes a plain "denied"
 * (can ask again) from "never_ask_again" (permanently denied — the OS will
 * no longer show the system prompt, so the only way forward is guiding the
 * user to App Settings, handled by openAppSettings() below).
 */
export async function requestSmsPermissions(): Promise<PermissionStatus> {
  if (Platform.OS !== "android") return "unavailable";

  const results = await PermissionsAndroid.requestMultiple(REQUIRED_PERMISSIONS as unknown as string[]);
  const values = Object.values(results);

  if (values.every((v) => v === PermissionsAndroid.RESULTS.GRANTED)) return "granted";
  if (values.some((v) => v === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN)) return "never_ask_again";
  return "denied";
}

/** Deep-links into this app's page in Android system Settings, for the "never_ask_again" case. */
export function openAppSettings(): Promise<void> {
  return Linking.openSettings();
}
