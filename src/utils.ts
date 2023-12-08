import picocolors from "picocolors";

const { red, yellow } = picocolors;

export namespace Utils {
  const verbose = !!process.argv.find((arg) => arg === "--verbose");

  /// Types

  export type MaybePromise<Type> = Promise<Type> | Type;

  export type MaybeArray<Type> = Type | Type[];

  /// Functions

  export function debug(...message: any[]) {
    if (verbose) console.debug(...message);
  }

  export const debouncedLog = debounceByArgs(log, 50);

  export function log(...message: any[]) {
    console.log(...message, "\n");
  }

  export function warn(...message: any[]) {
    console.warn(yellow("Warning:"), ...message, "\n");
  }

  export function error(...message: any[]) {
    console.error(red("Error:"), ...message, "\n");
  }

  export async function withRetry<Type>(
    fn: () => Promise<Type>,
    maxRetries: number,
    baseDelay: number
  ): Promise<Type> {
    let attempt = 0;
    while (true) {
      try {
        return await fn();
      } catch (error) {
        if (attempt >= maxRetries) throw error;
        const delayTime = baseDelay * Math.pow(1.6, attempt);
        await delay(delayTime);
        attempt++;
      }
    }
  }

  export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  export function areEqual<Type>(a: Type[], b: Type[]) {
    return a.length === b.length && a.every((item) => b.includes(item));
  }

  export function getMissingItems<Type>(actual: Type[], next: Type[]) {
    return next.filter((item) => !actual.includes(item));
  }

  export function getRedundantItems<Type>(actual: Type[], next: Type[]) {
    return actual.filter((item) => !next.includes(item));
  }

  export function getSetMissingItems<Type>(actual: Set<Type>, next: Set<Type>) {
    const missingItems = new Set<Type>();
    next.forEach((item) => {
      if (!actual.has(item)) missingItems.add(item);
    });
    return missingItems;
  }

  export function getSetRedundantItems<Type>(
    actual: Set<Type>,
    next: Set<Type>
  ) {
    const redundantItems = new Set<Type>();
    actual.forEach((item) => {
      if (!next.has(item)) redundantItems.add(item);
    });
    return redundantItems;
  }

  export function cloneDeepJSON<Type>(value: Type): Type {
    if (typeof value !== "object" || value === null) return value;

    if (Array.isArray(value))
      return value.map((item) => cloneDeepJSON(item)) as Type;

    const copiedObject: Record<string, any> = {};
    for (const key in value)
      if (Object.prototype.hasOwnProperty.call(value, key))
        copiedObject[key] = cloneDeepJSON(value[key]);

    return copiedObject as Type;
  }

  export function deepEqualJSON<Type>(value1: Type, value2: Type): boolean {
    if (value1 === value2) return true;

    if (
      typeof value1 !== "object" ||
      typeof value2 !== "object" ||
      value1 === null ||
      value2 === null
    )
      return false;

    if (Array.isArray(value1) && Array.isArray(value2)) {
      if (value1.length !== value2.length) return false;

      for (let i = 0; i < value1.length; i++)
        if (!deepEqualJSON(value1[i], value2[i])) return false;

      return true;
    }

    if (Array.isArray(value1) || Array.isArray(value2)) return false;

    const keys1 = Object.keys(value1);
    const keys2 = Object.keys(value2);

    if (keys1.length !== keys2.length) return false;

    for (const key of keys1) {
      if (!Object.prototype.hasOwnProperty.call(value2, key)) return false;

      if (!deepEqualJSON(value1[key as keyof Type], value2[key as keyof Type]))
        return false;
    }

    return true;
  }

  export function sortObject<Type extends Object>(obj: Type): Type {
    const sortedObj = {} as Type;
    Object.keys(obj)
      .sort()
      .forEach((key) => {
        sortedObj[key as keyof Type] = obj[key as keyof Type];
      });
    return sortedObj;
  }

  export function debounceByArgs<Fn extends (...args: any[]) => void>(
    func: Fn,
    waitFor: number
  ): (...args: Parameters<Fn>) => void {
    const timeouts: Record<string, NodeJS.Timeout> = {};

    return function (...args: Parameters<Fn>): void {
      const argsKey = JSON.stringify(args);
      const later = () => {
        delete timeouts[argsKey];
        func(...args);
      };

      clearTimeout(timeouts[argsKey]);
      timeouts[argsKey] = setTimeout(later, waitFor);
    };
  }

  export function areSetsEqual<Type>(set1: Set<Type>, set2: Set<Type>) {
    if (set1.size !== set2.size) return false;

    for (let a of set1) if (!set2.has(a)) return false;

    return true;
  }
}
