import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "@dalab_agent/sms_processed_ids";
const MAX_ENTRIES = 500; // bounded so this never grows unbounded on a long-lived device

/**
 * Tracks ids (see smsDedupeKey) of SMS that were already successfully
 * uploaded, persisted so a redelivered SMS_RECEIVED broadcast — which
 * Android can genuinely produce, e.g. after the app was killed and
 * restarted — doesn't get processed and uploaded a second time even across
 * app restarts. The in-flight retry queue (smsRetryQueue.ts) handles the
 * "still pending" case; this handles the "already succeeded" case.
 */
export class SmsProcessedStore {
  private ids: string[] = [];
  private loaded = false;

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      this.ids = raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      this.ids = [];
    }
    this.loaded = true;
  }

  async has(id: string): Promise<boolean> {
    await this.load();
    return this.ids.includes(id);
  }

  async markProcessed(id: string): Promise<void> {
    await this.load();
    if (this.ids.includes(id)) return;
    this.ids.push(id);
    if (this.ids.length > MAX_ENTRIES) {
      this.ids = this.ids.slice(this.ids.length - MAX_ENTRIES);
    }
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(this.ids));
  }
}
