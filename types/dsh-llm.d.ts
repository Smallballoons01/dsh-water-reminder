/**
 * Type-level augmentation for the harness packages this plugin builds against.
 *
 * dsh 0.2 removed the shared catch-all `kind: 'plugin'` entry from
 * `MessageSourceMap`: each producer now declares its own kind so a consumer can
 * switch on it and fall through the kinds it does not handle. A JavaScript
 * plugin cannot use `declare module` inline — that is TypeScript syntax and
 * Node rejects it at parse time — so the merge lives here, in a file TypeScript
 * reads and Node never loads.
 *
 * @module @dsh-plugin/water-reminder/types
 */

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A hydration nudge injected into a live session by this plugin. */
    'water-reminder': {
      kind: 'water-reminder'
    }
  }
}