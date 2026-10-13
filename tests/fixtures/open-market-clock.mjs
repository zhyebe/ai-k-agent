// Keep legacy entry/execution scenarios inside the trading day while real timers
// and elapsed time continue advancing. Closing boundaries have separate tests.
const NativeDate = globalThis.Date;
const date = new NativeDate(NativeDate.now() + 8 * 3600000).toISOString().slice(0, 10);
const offset = NativeDate.parse(`${date}T10:00:00+08:00`) - NativeDate.now();
globalThis.Date = class extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [NativeDate.now() + offset])); }
  static now() { return NativeDate.now() + offset; }
};
