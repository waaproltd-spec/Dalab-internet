import AsyncStorage from "@react-native-async-storage/async-storage";
import { QueuedSmsLog } from "../types/sms";

const STORAGE_KEY = "@dalab_agent/sms_retry_queue";

/**
 * Persists the retry queue to AsyncStorage so a failed upload isn't lost if
 * the app is killed before the retry succeeds — this is real, durable
 * storage (unlike a Claude artifact preview, this module runs as compiled
 * React Native code on an actual device, so AsyncStorage is the correct and
 * intended tool here, not a workaround).
 */
export class SmsRetryQueue {
  private items: QueuedSmsLog[] = [];
  private loaded = false;

  async load(): Promise<QueuedSmsLog[]> {
    if (this.loaded) return this.items;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      this.items = raw ? (JSON.parse(raw) as QueuedSmsLog[]) : [];
    } catch {
      this.items = []; // corrupt storage should never crash the listener
    }
    this.loaded = true;
    return this.items;
  }

  private async persist(): Promise<void> {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(this.items));
  }

  async has(id: string): Promise<boolean> {
    await this.load();
    return this.items.some((i) => i.id === id);
  }

  async enqueue(item: QueuedSmsLog): Promise<void> {
    await this.load();
    if (this.items.some((i) => i.id === item.id)) return; // dedupe guard
    this.items.push(item);
    await this.persist();
  }

  async remove(id: string): Promise<void> {
    await this.load();
    this.items = this.items.filter((i) => i.id !== id);
    await this.persist();
  }

  async recordFailure(id: string, error: string): Promise<void> {
    await this.load();
    const item = this.items.find((i) => i.id === id);
    if (!item) return;
    item.attempts += 1;
    item.lastError = error;
    await this.persist();
  }

  async all(): Promise<QueuedSmsLog[]> {
    return this.load();
  }
}
