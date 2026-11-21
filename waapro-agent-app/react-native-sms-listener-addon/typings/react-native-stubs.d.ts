/**
 * MINIMAL AMBIENT DECLARATIONS — for local `tsc --noEmit` checking only.
 *
 * This sandbox has no network access to `npm install react-native` and its
 * real type definitions, so this file declares just enough of the react-native
 * surface used by this feature to type-check the hook's logic honestly.
 *
 * DELETE THIS FILE once dropped into a real React Native project — the real
 * `react-native` package ships its own complete, correct types, and this
 * stand-in would otherwise shadow them.
 */
declare module "react-native" {
  export type AppStateStatus = "active" | "background" | "inactive" | "unknown" | "extension";

  export interface EmitterSubscription {
    remove(): void;
  }

  export class NativeEventEmitter {
    constructor(nativeModule?: unknown);
    addListener(eventType: string, listener: (event: any) => void): EmitterSubscription;
  }

  export const NativeModules: Record<string, any>;

  export const Platform: {
    OS: "ios" | "android" | "windows" | "macos" | "web";
  };

  export const Linking: {
    openSettings(): Promise<void>;
  };

  export const AppState: {
    addEventListener(type: "change", handler: (state: AppStateStatus) => void): { remove(): void };
  };

  export const PermissionsAndroid: {
    PERMISSIONS: {
      READ_SMS: string;
      RECEIVE_SMS: string;
      [key: string]: string;
    };
    RESULTS: {
      GRANTED: "granted";
      DENIED: "denied";
      NEVER_ASK_AGAIN: "never_ask_again";
    };
    check(permission: string): Promise<boolean>;
    request(permission: string): Promise<string>;
    requestMultiple(permissions: string[]): Promise<Record<string, string>>;
  };
}

declare module "@react-native-async-storage/async-storage" {
  interface AsyncStorageStatic {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
  }
  const AsyncStorage: AsyncStorageStatic;
  export default AsyncStorage;
}
