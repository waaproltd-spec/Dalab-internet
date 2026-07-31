/**
 * MINIMAL AMBIENT DECLARATIONS for the small slice of React used here —
 * same purpose and same caveat as react-native-stubs.d.ts: this sandbox has
 * no network access to install the real `react` + `@types/react` packages.
 * DELETE THIS FILE in a real project; it would otherwise shadow the real,
 * complete React types.
 */
declare module "react" {
  export function useState<S>(initial: S | (() => S)): [S, (value: S | ((prev: S) => S)) => void];
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useCallback<T extends (...args: any[]) => any>(callback: T, deps: readonly unknown[]): T;
  export function useRef<T>(initial: T): { current: T };
}
